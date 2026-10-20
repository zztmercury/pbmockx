/**
 * CertAuthority — local root CA + on-demand leaf certificates for HTTPS MITM.
 *
 * Layout (~/.pbmockx/ca by default):
 *   ca.pem / ca.key   root CA (RSA 2048, 10 years, key chmod 0600)
 *   leaf.key          one shared leaf private key (fast per-host signing)
 *   <nothing else>    leaf certs are cached in memory only
 *
 * Clients must trust ca.pem. `host` comes from the CONNECT request, so the
 * leaf cert always matches the host the client asked for (SNI-independent).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as tls from 'tls';

// node-forge ships no stable TS types for the generation callback; use any.
const forge: any = require('node-forge');

export interface CaInfo {
  path: string;
  subject: string;
  fingerprint256: string;
  subjectHashOld: string;
  notBefore: string;
  notAfter: string;
  keyPath: string;
}

function isIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^[0-9a-f:]+$/i.test(host);
}

function generateKeyPair(bits = 2048): Promise<any> {
  return new Promise((resolve, reject) => {
    forge.pki.rsa.generateKeyPair({ bits }, (err: any, keypair: any) => {
      if (err) reject(err);
      else resolve(keypair);
    });
  });
}

export class CertAuthority {
  private dir: string;
  private caCert: any = null;
  private caKey: any = null;
  private leafKey: any = null;
  private secureContexts = new Map<string, tls.SecureContext>();
  private leafPems = new Map<string, { key: string; cert: string }>();
  private inflight = new Map<string, Promise<{ key: string; cert: string }>>();

  constructor(dir: string) {
    this.dir = dir;
  }

  private get caCertFile(): string { return path.join(this.dir, 'ca.pem'); }
  private get caKeyFile(): string { return path.join(this.dir, 'ca.key'); }
  private get leafKeyFile(): string { return path.join(this.dir, 'leaf.key'); }

  async ensure(): Promise<void> {
    if (this.caCert && this.caKey && this.leafKey) return;
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this.caCertFile) && fs.existsSync(this.caKeyFile)) {
      try {
        this.caCert = forge.pki.certificateFromPem(fs.readFileSync(this.caCertFile, 'utf-8'));
        this.caKey = forge.pki.privateKeyFromPem(fs.readFileSync(this.caKeyFile, 'utf-8'));
      } catch (e: any) {
        throw new Error(`cannot load CA at ${this.dir}: ${e.message}. Run: pbmockx ca --regen --yes`);
      }
    } else {
      await this.createCa();
    }

    if (fs.existsSync(this.leafKeyFile)) {
      try {
        this.leafKey = forge.pki.privateKeyFromPem(fs.readFileSync(this.leafKeyFile, 'utf-8'));
      } catch {
        this.leafKey = null;
      }
    }
    if (!this.leafKey) {
      const kp = await generateKeyPair(2048);
      this.leafKey = kp.privateKey;
      fs.writeFileSync(this.leafKeyFile, forge.pki.privateKeyToPem(kp.privateKey), { mode: 0o600 });
    }
  }

  private async createCa(): Promise<void> {
    const kp = await generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = kp.publicKey;
    cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(16));
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
    cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);
    const attrs = [
      { name: 'commonName', value: 'pbmockx local CA' },
      { name: 'organizationName', value: 'pbmockx' },
      { name: 'organizationalUnitName', value: 'local debugging only' },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true },
      {
        name: 'keyUsage',
        keyCertSign: true,
        cRLSign: true,
        digitalSignature: true,
        critical: true,
      },
      { name: 'subjectKeyIdentifier' },
    ]);
    cert.sign(kp.privateKey, forge.md.sha256.create());

    fs.writeFileSync(this.caCertFile, forge.pki.certificateToPem(cert), { mode: 0o644 });
    fs.writeFileSync(this.caKeyFile, forge.pki.privateKeyToPem(kp.privateKey), { mode: 0o600 });
    this.caCert = cert;
    this.caKey = kp.privateKey;
  }

  getCaPem(): string {
    if (!this.caCert) throw new Error('CA not initialized');
    return forge.pki.certificateToPem(this.caCert);
  }

  /** Recreate the CA and drop every cached leaf cert. */
  async regenerate(): Promise<void> {
    for (const f of [this.caCertFile, this.caKeyFile, this.leafKeyFile]) {
      try { fs.unlinkSync(f); } catch {}
    }
    this.caCert = null;
    this.caKey = null;
    this.leafKey = null;
    this.secureContexts.clear();
    this.leafPems.clear();
    this.inflight.clear();
    await this.ensure();
  }

  info(): CaInfo {
    if (!this.caCert) throw new Error('CA not initialized');
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(this.caCert)).getBytes();
    const fingerprint = crypto.createHash('sha256').update(Buffer.from(der, 'binary')).digest('hex');
    return {
      path: this.caCertFile,
      keyPath: this.caKeyFile,
      subject: this.caCert.subject.getField('CN')?.value || '',
      fingerprint256: fingerprint.match(/.{2}/g)!.join(':').toUpperCase(),
      subjectHashOld: this.subjectHashOld(),
      notBefore: this.caCert.validity.notBefore.toISOString(),
      notAfter: this.caCert.validity.notAfter.toISOString(),
    };
  }

  subjectHashOld(): string {
    const der = forge.asn1.toDer(forge.pki.distinguishedNameToAsn1(this.caCert.subject)).getBytes();
    return crypto
      .createHash('md5')
      .update(Buffer.from(der, 'binary'))
      .digest()
      .readUInt32LE(0)
      .toString(16)
      .padStart(8, '0');
  }

  /** Leaf key+cert PEM for a host; signs and caches on first use. */
  async getLeafPems(host: string): Promise<{ key: string; cert: string }> {
    await this.ensure();
    const key = (host || 'unknown').toLowerCase();
    const cached = this.leafPems.get(key);
    if (cached) return cached;
    const running = this.inflight.get(key);
    if (running) return running;

    const p = (async () => {
      const cert = forge.pki.createCertificate();
      cert.publicKey = forge.pki.setRsaPublicKey(this.leafKey.n, this.leafKey.e);
      cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(16));
      cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
      cert.validity.notAfter = new Date(Date.now() + 2 * 365 * 24 * 3600 * 1000);
      cert.setSubject([{ name: 'commonName', value: host }]);
      cert.setIssuer(this.caCert.subject.attributes);
      const alt = isIp(host)
        ? [{ type: 7, ip: host }]
        : [{ type: 2, value: host }];
      cert.setExtensions([
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: alt },
      ]);
      cert.sign(this.caKey, forge.md.sha256.create());
      const pems = {
        key: forge.pki.privateKeyToPem(this.leafKey),
        cert: forge.pki.certificateToPem(cert),
      };
      this.leafPems.set(key, pems);
      return pems;
    })();

    this.inflight.set(key, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Secure context for a host (cached). */
  async getSecureContext(host: string): Promise<tls.SecureContext> {
    const key = (host || 'unknown').toLowerCase();
    const cached = this.secureContexts.get(key);
    if (cached) return cached;
    const pems = await this.getLeafPems(host);
    const ctx = tls.createSecureContext(pems);
    this.secureContexts.set(key, ctx);
    return ctx;
  }
}
