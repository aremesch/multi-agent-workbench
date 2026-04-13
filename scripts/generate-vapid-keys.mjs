#!/usr/bin/env node
import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
console.log(`MAW_VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`MAW_VAPID_PRIVATE_KEY=${keys.privateKey}`);
