// firebase-init.js
const firebaseConfig = {
  apiKey: "AIzaSyBIOff0UYYiYgAKgQuclBAZYf0q-yAHWzo",
  authDomain: "digipicdb.firebaseapp.com",
  projectId: "digipicdb",
  storageBucket: "digipicdb.firebasestorage.app",
  messagingSenderId: "846231361877",
  appId: "1:846231361877:web:5203792c2c20b8bd97b7dc",
  measurementId: "G-MT779L1K22"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

window.db = firebase.firestore();
