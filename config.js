/* Client OAuth « Application Web » (gratuit, Google Cloud).
   Le client_id n’est pas un secret. Ne mets JAMAIS le client_secret ici.
   Voir SETUP.html pour créer le bon type de client. */
window.PM_CONFIG = {
  // Remplace par le Client ID de type « Application Web » (SETUP.html)
  clientId: "990544737644-rt229eqf82kaq6qq6aailafpq3m36858.apps.googleusercontent.com",
  // Scopes Gmail lecture + modification labels (tri)
  scopes: "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.labels",
  labels: {
    junk: "PersonalMail/Pubs",
    job: "PersonalMail/Recrutement",
    todo: "PersonalMail/A-traiter",
    important: "PersonalMail/Important",
    summary: "PersonalMail/Resume",
  },
};
