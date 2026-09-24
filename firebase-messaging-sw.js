importScripts("https://www.gstatic.com/firebasejs/12.19.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyD5Nlp9CAlPMnF7cMqTIhEJxsk4FKLafKE",
  authDomain: "jules-et-li-na.firebaseapp.com",
  projectId: "jules-et-li-na",
  storageBucket: "jules-et-li-na.firebasestorage.app",
  messagingSenderId: "78432673273",
  appId: "1:78432673273:web:4e6125ed2b8237d05e7128"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload) {
  const notificationTitle = payload.notification.title || "Nouveau message !";
  const notificationOptions = {
    body: payload.notification.body,
    icon: "/assets/icon-192.png"
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});