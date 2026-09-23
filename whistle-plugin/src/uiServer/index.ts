/**
 * uiServer — Koa application providing CGI routes for CLI and inspectorsTab.
 */

import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import Router from '@koa/router';
import setupRouter from './router';

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
  setupRouter(router);
  app.use(router.routes());
  app.use(router.allowedMethods());

  // Static files from public/ are served by whistle automatically — no need here

  server.on('request', app.callback());
};
