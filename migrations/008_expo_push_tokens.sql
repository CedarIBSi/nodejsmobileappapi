-- The client now registers Expo push tokens (via expo-notifications) rather
-- than raw FCM tokens, so the column is renamed to match what it actually
-- stores. Sending goes through Expo's push API, not firebase-admin/messaging.
ALTER TABLE push_tokens RENAME COLUMN fcm_token TO expo_push_token;
