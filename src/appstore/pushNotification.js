'use strict';

// Minimal single-user Expo push sender — trimmed slice of
// upcheck_admin/src/lib/pushNotifications.js's sendPushNotification(),
// ported for the one App Store use case (notify subscribers a new version
// shipped). Deliberately does not port the sound/channel routing logic
// (chat-specific) or sendPushNotificationToAll (unused here).
const { ObjectId } = require('mongodb');
const { getDb } = require('../db');

async function sendPushNotification(userId, title, body, data = {}) {
  try {
    const db = getDb();
    const user = await db.collection('admin_users').findOne({ _id: new ObjectId(userId) });

    const tokens = Array.from(new Set([
      ...(Array.isArray(user && user.expoPushTokens) ? user.expoPushTokens : []),
      ...((user && user.expoPushToken) ? [user.expoPushToken] : []),
    ].filter(Boolean)));

    if (!user || tokens.length === 0) return;

    const messages = tokens.map((token) => ({
      to: token,
      sound: 'default',
      priority: 'high',
      title,
      body,
      data,
    }));

    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Accept-encoding': 'gzip, deflate', 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[appstore] push notification error:', error.message);
  }
}

module.exports = { sendPushNotification };
