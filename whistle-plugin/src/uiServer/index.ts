/**
 * uiServer — Koa application providing CGI routes for CLI and inspectorsTab.
 */

import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import Router from '@koa/router';
import setupRouter from './router';
import { syncNativeRules } from '../native-rules';

export default (server: any, options: any) => {
  const app = new Koa();
  const router = new Router();

  app.proxy = true;
  app.silent = true;

  app.use(async (ctx, next) => {
    try { await next(); } catch (e: any) {
      ctx.status = 500;
      ctx.body = { error: e.message };
    }
  });

  app.use(bodyParser());
  setupRouter(router, options);
  app.use(router.routes());
  app.use(router.allowedMethods());

  // Static files from public/ are served by whistle automatically — no need here

  server.on('request', app.callback());

  // Best-effort: re-publish map_remote / map_local(file) rules into whistle's
  // native rule store after startup (the plugin's rulesServer hook is not
  // invoked for ordinary HTTP traffic on whistle 2.10.x). Never fatal.
  setTimeout(() => {
    syncNativeRules(options)
      .then((res) => {
        if (!res.ok) console.error('[pbmockx] native rules sync failed: ' + res.error);
      })
      .catch((e) => console.error('[pbmockx] native rules sync failed: ' + (e && e.message ? e.message : e)));
  }, 500);
};
