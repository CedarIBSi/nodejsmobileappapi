/**
 * Exercises /auth/action in isolation: `npx tsx scripts/check-auth-action.ts`.
 *
 * This route is the URL registered in the Firebase console as the custom email
 * action handler, and Google validates it before accepting a change. A failed
 * validation costs about two days of back-and-forth with support, so the route
 * is worth checking before a deploy rather than after one.
 *
 * It was rejected once already: every malformed request came back as a JSON 400
 * from the shared validator, listing the endpoint's accepted parameters, their
 * types and the full set of valid modes. The first four checks below are that
 * bug.
 *
 * Mounts only that router on a bare Express app - no database, no Firebase
 * Admin - so every branch can be driven with a plain fetch. Dummy env values
 * satisfy config(); none of them are real and none are used for anything but
 * building a redirect URL.
 */
process.env.DATABASE_URL ??= 'postgres://u:p@127.0.0.1:5432/none';
process.env.FIREBASE_PROJECT_ID ??= 'test-project';
process.env.FIREBASE_CLIENT_EMAIL ??= 'test@example.com';
process.env.FIREBASE_PRIVATE_KEY ??= 'x';
process.env.FIREBASE_AUTH_DOMAIN ??= 'test-project.firebaseapp.com';
process.env.APP_BASE_URL ??= 'https://example.com';
process.env.MOBILE_APP_SCHEME ??= 'ibsintelligence';

import express from 'express';
import { authActionRouter } from '../src/routes/auth-action.js';

const app = express();
app.use((req, _res, next) => {
  // The real app attaches a logger; the router only calls info/warn/error.
  (req as unknown as { log: unknown }).log = {
    error: () => {},
    info: () => {},
    warn: () => {},
  };
  next();
});
app.use('/auth/action', authActionRouter);

const server = app.listen(0);
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const closeServer = () =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

const DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';
const SCANNER = 'Mozilla/5.0 (compatible; Safe-Links-Scanner/1.0)';

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];

const record = (name: string, pass: boolean, detail: string) =>
  checks.push({ detail, name, pass });

/** Anything that would tell a stranger how the endpoint is built. */
const LEAKS = [
  'VALIDATION_ERROR',
  'fieldErrors',
  'formErrors',
  'expected string',
  'Invalid option',
  'oobCode"]',
  'zod',
  'at Object.',
  'node_modules',
];

async function get(path: string, ua = DESKTOP) {
  const res = await fetch(base + path, {
    headers: { 'user-agent': ua },
    redirect: 'manual',
  });
  return { body: await res.text(), res };
}

async function run() {
  // 1. The exact request Firebase's validator made.
  {
    const { body, res } = await get('/auth/action');
    record('bare URL is HTML', (res.headers.get('content-type') ?? '').includes('text/html'),
      res.headers.get('content-type') ?? 'none');
    record('bare URL is not 4xx/5xx', res.status < 400, 'HTTP ' + res.status);
    record('bare URL leaks nothing', !LEAKS.some((l) => body.includes(l)),
      LEAKS.filter((l) => body.includes(l)).join(', ') || 'clean');
    record('bare URL is a real page', body.includes('<!doctype html>') && body.includes('</html>'),
      body.slice(0, 40));
  }

  // 2. Partial and malformed parameters.
  for (const q of [
    '?mode=verifyEmail',
    '?oobCode=abcdefgh',
    '?mode=nonsense&oobCode=abcdefgh',
    '?mode=verifyEmail&oobCode=short',
    '?mode=verifyEmail&oobCode=' + 'a'.repeat(5000),
    '?mode[]=verifyEmail&oobCode[]=abcdefgh',
  ]) {
    const { body, res } = await get('/auth/action' + q);
    const html = (res.headers.get('content-type') ?? '').includes('text/html');
    record('bad params -> page: ' + q.slice(0, 38),
      html && res.status < 400 && !LEAKS.some((l) => body.includes(l)),
      'HTTP ' + res.status + ' ' + (res.headers.get('content-type') ?? ''));
  }

  // 3. Every documented mode, with a well-formed code.
  const code = 'ABCDEFGHIJKLMNOP';
  const key = 'AIzaSyTESTKEY';

  {
    const { res } = await get(`/auth/action?mode=resetPassword&oobCode=${code}&apiKey=${key}`);
    const loc = res.headers.get('location') ?? '';
    record('resetPassword -> Firebase handler',
      res.status === 302 && loc.includes('firebaseapp.com/__/auth/action') && loc.includes(code),
      'HTTP ' + res.status + ' ' + loc.slice(0, 70));
  }

  {
    const { res } = await get(
      `/auth/action?mode=verifyEmail&oobCode=${code}&apiKey=${key}`, ANDROID);
    const loc = res.headers.get('location') ?? '';
    record('verifyEmail on a phone -> app',
      res.status === 302 && loc.startsWith('ibsintelligence://app-auth') && loc.includes(code),
      'HTTP ' + res.status + ' ' + loc.slice(0, 60));
  }

  // The app matches on verifyEmail alone, so anything else must reach a page
  // that can actually finish the job rather than opening the app to nothing.
  for (const mode of ['recoverEmail', 'verifyAndChangeEmail']) {
    const { body, res } = await get(
      `/auth/action?mode=${mode}&oobCode=${code}&apiKey=${key}`, ANDROID);
    record(mode + ' on a phone -> form, not the app',
      res.status === 200 && body.includes('method="post"'),
      'HTTP ' + res.status + ' ' + (res.headers.get('location') ?? 'no redirect'));
  }

  // 4. The desktop form, and the wording it uses per mode.
  const expectedHeading: Record<string, string> = {
    recoverEmail: 'Restore your email address',
    verifyAndChangeEmail: 'Confirm your new email address',
    verifyEmail: 'Confirm your email address',
  };

  for (const [mode, heading] of Object.entries(expectedHeading)) {
    const { body, res } = await get(
      `/auth/action?mode=${mode}&oobCode=${code}&apiKey=${key}`, SCANNER);
    record(mode + ' on desktop -> its own wording',
      res.status === 200 && body.includes(heading) && body.includes('method="post"'),
      body.includes(heading) ? 'ok' : 'heading not found');
    record(mode + ' redeems nothing on GET', !body.includes('identitytoolkit'), 'no call on load');
  }

  // 5. The reason this route exists: a scanner must not spend the code.
  {
    const { body, res } = await get(
      `/auth/action?mode=verifyEmail&oobCode=${code}&apiKey=${key}`, SCANNER);
    record('scanner gets a form, not a redemption',
      res.status === 200 && body.includes('<form') && !body.includes('confirmed'),
      'HTTP ' + res.status);
  }

  // 6. Injection through the values that get reflected into the form.
  {
    const evil = 'abc"><script>alert(1)</script>';
    const { body } = await get(
      `/auth/action?mode=verifyEmail&oobCode=${encodeURIComponent(evil)}&apiKey=${key}`);
    record('reflected values are escaped',
      !body.includes('<script>alert(1)</script>'),
      body.includes('&lt;script&gt;') ? 'escaped' : 'NOT ESCAPED');
  }

  // 7. A bad POST must answer with a page too.
  {
    const res = await fetch(base + '/auth/action/confirm', {
      body: 'mode=verifyEmail',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': DESKTOP },
      method: 'POST',
    });
    const body = await res.text();
    record('bad POST -> page, no leak',
      (res.headers.get('content-type') ?? '').includes('text/html') &&
        !LEAKS.some((l) => body.includes(l)),
      'HTTP ' + res.status + ' ' + (res.headers.get('content-type') ?? ''));
  }

  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(46)} ${c.detail}`);
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  await closeServer();
  if (failed.length) process.exitCode = 1;
}

run().catch(async (error) => {
  console.error('harness failed:', error);
  await closeServer().catch(() => undefined);
  process.exitCode = 1;
});
