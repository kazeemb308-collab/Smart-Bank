const admin = require('firebase-admin');

const credentialsJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const firebaseEnabled = Boolean(credentialsJson);

let db = null;

if (firebaseEnabled) {
  try {
    const serviceAccount = JSON.parse(credentialsJson);

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }

    db = admin.firestore();
    db.settings({ ignoreUndefinedProperties: true });
  } catch (error) {
    console.error('Firebase initialization failed:', error.message);
    throw error;
  }
}

async function loadPersistentState(fallbackLoader) {
  if (!firebaseEnabled) {
    return fallbackLoader();
  }

  const ref = db.collection('smart_bank').doc('state');
  const snapshot = await ref.get();

  if (snapshot.exists) {
    return snapshot.data();
  }

  // One-time migration: preserve the existing data.json on first Firebase startup.
  const existingState = fallbackLoader();
  await ref.set(existingState);
  console.log('Smart Bank data migrated to Firestore.');
  return existingState;
}

async function savePersistentState(state) {
  if (!firebaseEnabled) {
    return;
  }

  await db.collection('smart_bank').doc('state').set(state);
}

module.exports = {
  firebaseEnabled,
  loadPersistentState,
  savePersistentState
};
