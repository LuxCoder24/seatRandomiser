// Firebase setup — paste your config values from the Firebase console below.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ===== PASTE YOUR FIREBASE CONFIG HERE =====
const firebaseConfig = {
  apiKey: "AIzaSyBi41ksoX_bFkp91V1sGRVVf1-aYaX2CTc",
  authDomain: "seat-chooser-e4570.firebaseapp.com",
  databaseURL: "https://seat-chooser-e4570-default-rtdb.firebaseio.com",
  projectId: "seat-chooser-e4570",
  storageBucket: "seat-chooser-e4570.firebasestorage.app",
  messagingSenderId: "409291819141",
  appId: "1:409291819141:web:64e398ede2ebd486b781ec",
  measurementId: "G-Y7ZYRTZ245"
};
// ===========================================

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
export { signInWithPopup, signOut, onAuthStateChanged, doc, getDoc, setDoc };