window.APP_CONFIG = {
  firebase: {
    apiKey: "AIzaSyD5Nlp9CAlPMnF7cMqTIhEJxsk4FKLafKE",
    authDomain: "jules-et-li-na.firebaseapp.com",
    projectId: "jules-et-li-na",
    storageBucket: "jules-et-li-na.firebasestorage.app",
    messagingSenderId: "78432673273",
    appId: "1:78432673273:web:4e6125ed2b8237d05e7128",
    measurementId: "G-EZCQKT1585"
  },
  userLoginEmail: "li.na@site.local",
  adminLoginEmail: "admin@site.local"
};

if (typeof firebase !== 'undefined' && !firebase.apps.length) {
  firebase.initializeApp(window.APP_CONFIG.firebase);
}