self.addEventListener("notificationclick", function(event) {
  event.notification.close();

  const targetUrl = "https://julesgerent.github.io/julesli-na/";

  event.waitUntil(
    clients.matchAll({
      type: "window",
      includeUncontrolled: true
    }).then(function(clientList) {

      for (const client of clientList) {
        if (client.url.startsWith(targetUrl) && "focus" in client) {
          return client.focus();
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});


importScripts(
  "https://www.gstatic.com/firebasejs/12.19.0/firebase-app-compat.js"
);

importScripts(
  "https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging-compat.js"
);


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
  console.log(
    "[firebase-messaging-sw.js] Message reçu :",
    payload
  );
});