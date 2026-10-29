/**
 * CLI help text. Every command supports -h/--help.
 *
 * The blocks live in the i18n catalogs (`help.*`); command names, flags and the
 * `Usage:` lines stay verbatim in both languages.
 */

import { t } from '../i18n';

export function helpMain(): void {
  console.log(t('help.main'));
}

export function helpFlows(): void {
  console.log(t('help.flows'));
}

export function helpDecode(): void {
  console.log(t('help.decode'));
}

export function helpRules(): void {
  console.log(t('help.rules'));
}

export function helpMapLocal(): void {
  console.log(t('help.mapLocal'));
}

export function helpMapRemote(): void {
  console.log(t('help.mapRemote'));
}

export function helpStart(): void {
  console.log(t('help.start'));
}

export function helpRestart(): void {
  console.log(t('help.restart'));
}

export function helpStop(): void {
  console.log(t('help.stop'));
}

export function helpStatus(): void {
  console.log(t('help.status'));
}

export function helpLogs(): void {
  console.log(t('help.logs'));
}

export function helpCa(): void {
  console.log(t('help.ca'));
}

export function helpWeb(): void {
  console.log(t('help.web'));
}

export function helpConnectAndroid(): void {
  console.log(t('help.connectAndroid'));
}

export function helpDoctor(): void {
  console.log(t('help.doctor'));
}

export function helpFix(): void {
  console.log(t('help.fix'));
}

export function helpAgentDoc(): void {
  console.log(t('help.agentDoc'));
}

export function helpSkill(): void {
  console.log(t('help.skill'));
}

export function helpVersion(): void {
  console.log(t('help.version'));
}

export function helpLang(): void {
  console.log(t('help.lang'));
}
