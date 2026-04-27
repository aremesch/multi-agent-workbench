/**
 * Catch-all delegating to better-auth's request handler.
 *
 * Mounts every endpoint better-auth exposes (sign-in/email, sign-out,
 * change-password, get-session, …) under `/api/auth/*`. Better-auth handles
 * URL routing, body parsing, CSRF, and cookies internally; we just forward
 * the Request and return its Response.
 */

import type { RequestHandler } from './$types';
import { auth } from '$lib/server/auth/betterAuth';

const handler: RequestHandler = ({ request }) => auth.handler(request);

export const GET = handler;
export const POST = handler;
