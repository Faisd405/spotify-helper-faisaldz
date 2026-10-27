// Copy to config.js (git-ignored) and fill in the same values as .env.
// Same public value as VITE_FIREBASE_DATABASE_URL (it already ships in the web bundle);
// the database rules are what protect it.
const DB_URL = "https://YOUR-PROJECT-default-rtdb.REGION.firebasedatabase.app"; // = VITE_FIREBASE_DATABASE_URL

// Public Firebase web API key (also in the web bundle); used for anonymous sign-in only.
const API_KEY = "YOUR_FIREBASE_WEB_API_KEY"; // = VITE_FIREBASE_API_KEY
