/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

declare const self: ServiceWorkerGlobalScope;

const CACHE_NAME = `maw-cache-${version}`;

const PRECACHE_URLS = [
	...build,
	...files.filter((f) => !f.endsWith('.webmanifest'))
];

// ── Install: precache app shell ─────────────────────────────────────
self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE_NAME)
			.then((cache) => cache.addAll(PRECACHE_URLS))
			.then(() => self.skipWaiting())
	);
});

// ── Activate: purge stale caches ────────────────────────────────────
self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys
						.filter((k) => k.startsWith('maw-cache-') && k !== CACHE_NAME)
						.map((k) => caches.delete(k))
				)
			)
			.then(() => self.clients.claim())
	);
});

// ── Fetch: cache-first for assets, network-first for navigation ─────
self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);

	// Skip non-GET, API routes, and WebSocket endpoint
	if (event.request.method !== 'GET') return;
	if (url.pathname.startsWith('/api/')) return;
	if (url.pathname === '/ws') return;

	// Immutable build assets (fingerprinted): cache-first
	if (url.pathname.startsWith('/_app/immutable/')) {
		event.respondWith(
			caches.match(event.request).then((cached) => cached || fetch(event.request))
		);
		return;
	}

	// Navigation requests: network-first with offline fallback
	if (event.request.mode === 'navigate') {
		event.respondWith(
			fetch(event.request).catch(
				() =>
					caches.match(event.request).then((cached) => cached || offlineResponse()) as Promise<Response>
			)
		);
		return;
	}

	// Other static files: cache-first, fallback to network
	event.respondWith(
		caches.match(event.request).then((cached) => cached || fetch(event.request))
	);
});

// ── Offline fallback ────────────────────────────────────────────────
function offlineResponse(): Response {
	return new Response(
		`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="theme-color" content="#0a0a0a"/>
<title>Offline — MAW</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;color:#e0e0e0;font-family:system-ui,-apple-system,sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100dvh;padding:2rem}
.card{text-align:center;max-width:28rem}
h1{font-size:1.5rem;margin-bottom:.75rem;color:#a5d6ff}
p{line-height:1.5;margin-bottom:1.5rem;color:#999}
button{background:#a5d6ff;color:#0a0a0a;border:none;padding:.625rem 1.5rem;
border-radius:.375rem;font-size:.875rem;font-weight:600;cursor:pointer}
button:active{opacity:.8}
</style>
</head>
<body>
<div class="card">
<h1>You're offline</h1>
<p>Multi-Agent Workbench needs a connection to manage your agents.
Check your network and try again.</p>
<button onclick="location.reload()">Retry</button>
</div>
</body>
</html>`,
		{ status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
	);
}

// ── Push notifications ──────────────────────────────────────────────
self.addEventListener('push', (event) => {
	if (!event.data) return;
	const payload = event.data.json() as {
		title: string;
		body: string;
		data: { agentId: string; alertId: string; url: string };
	};
	event.waitUntil(
		self.registration.showNotification(payload.title, {
			body: payload.body,
			icon: '/icons/icon-192.png',
			badge: '/icons/icon-192.png',
			tag: `maw-${payload.data.agentId}`,
			renotify: true,
			data: payload.data
		})
	);
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const url = (event.notification.data as { url?: string })?.url ?? '/';
	event.waitUntil(
		self.clients
			.matchAll({ type: 'window', includeUncontrolled: true })
			.then((clients) => {
				for (const client of clients) {
					if (new URL(client.url).origin === self.location.origin) {
						client.focus();
						client.navigate(url);
						return;
					}
				}
				return self.clients.openWindow(url);
			})
	);
});
