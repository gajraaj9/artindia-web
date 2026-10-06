/* GENERATED from data/teams.json and data/team-copy.json by
   build-diwali.mjs. Do not edit. Edit the data files and rebuild. */

export const TEAMS = [
  {
    "key": "core",
    "letter": "core",
    "env": "TT_TYPE_CORE",
    "expected": 15,
    "plusOne": false,
    "promoCode": true,
    "wall": true,
    "name": {
      "en": "Core team",
      "fr": "Équipe centrale",
      "nl": "Kernteam"
    },
    "arrival": {
      "en": "",
      "fr": "",
      "nl": ""
    }
  },
  {
    "key": "crew",
    "letter": null,
    "env": "TT_TYPE_CREW",
    "expected": 10,
    "plusOne": false,
    "promoCode": false,
    "wall": true,
    "name": {
      "en": "Technical crew",
      "fr": "Équipe technique",
      "nl": "Technische ploeg"
    },
    "arrival": {
      "en": "",
      "fr": "",
      "nl": ""
    }
  },
  {
    "key": "dj",
    "letter": null,
    "env": "TT_TYPE_DJ",
    "expected": 7,
    "plusOne": false,
    "promoCode": true,
    "wall": true,
    "name": {
      "en": "DJ team",
      "fr": "Équipe DJ",
      "nl": "Dj-team"
    },
    "arrival": {
      "en": "",
      "fr": "",
      "nl": ""
    }
  },
  {
    "key": "media",
    "letter": null,
    "env": "TT_TYPE_MEDIA",
    "expected": 10,
    "plusOne": false,
    "promoCode": true,
    "wall": true,
    "name": {
      "en": "Media team",
      "fr": "Équipe média",
      "nl": "Mediateam"
    },
    "arrival": {
      "en": "",
      "fr": "",
      "nl": ""
    }
  },
  {
    "key": "artist",
    "letter": "artist",
    "env": "TT_TYPE_ARTIST",
    "expected": 30,
    "plusOne": true,
    "promoCode": true,
    "wall": true,
    "name": {
      "en": "Main artists",
      "fr": "Artistes principaux",
      "nl": "Hoofdartiesten"
    },
    "arrival": {
      "en": "",
      "fr": "",
      "nl": ""
    }
  },
  {
    "key": "collab",
    "letter": "artist",
    "env": "TT_TYPE_COLLAB",
    "expected": 20,
    "plusOne": false,
    "promoCode": true,
    "wall": true,
    "name": {
      "en": "Collab artists",
      "fr": "Artistes collaborateurs",
      "nl": "Collab-artiesten"
    },
    "arrival": {
      "en": "",
      "fr": "",
      "nl": ""
    }
  },
  {
    "key": "aimc",
    "letter": "artist",
    "env": "TT_TYPE_AIMC",
    "expected": 15,
    "plusOne": false,
    "promoCode": true,
    "wall": true,
    "name": {
      "en": "AIMC music team",
      "fr": "Équipe musicale AIMC",
      "nl": "AIMC-muziekteam"
    },
    "arrival": {
      "en": "",
      "fr": "",
      "nl": ""
    }
  },
  {
    "key": "child",
    "letter": "parent",
    "env": "TT_TYPE_CHILD",
    "expected": 50,
    "plusOne": false,
    "promoCode": true,
    "wall": false,
    "childTeam": true,
    "name": {
      "en": "Child artists",
      "fr": "Jeunes artistes",
      "nl": "Kindartiesten"
    },
    "arrival": {
      "en": "",
      "fr": "",
      "nl": ""
    }
  },
  {
    "key": "vip",
    "letter": null,
    "env": "TT_TYPE_VIP",
    "expected": 30,
    "plusOne": false,
    "promoCode": false,
    "wall": false,
    "inviteOnly": true,
    "name": {
      "en": "VIPs",
      "fr": "Invités d'honneur",
      "nl": "Eregasten"
    },
    "arrival": {
      "en": "",
      "fr": "",
      "nl": ""
    }
  },
  {
    "key": "press",
    "letter": null,
    "env": "TT_TYPE_PRESS",
    "expected": 20,
    "plusOne": false,
    "promoCode": false,
    "wall": false,
    "name": {
      "en": "Press",
      "fr": "Presse",
      "nl": "Pers"
    },
    "arrival": {
      "en": "",
      "fr": "",
      "nl": ""
    }
  },
  {
    "key": "guest",
    "letter": null,
    "env": "TT_TYPE_GUEST",
    "expected": 30,
    "plusOne": false,
    "promoCode": false,
    "wall": false,
    "name": {
      "en": "Guests",
      "fr": "Invités",
      "nl": "Gasten"
    },
    "arrival": {
      "en": "",
      "fr": "",
      "nl": ""
    }
  },
  {
    "key": "plus1",
    "letter": null,
    "env": "TT_TYPE_PLUS1",
    "expected": 30,
    "plusOne": false,
    "promoCode": false,
    "wall": false,
    "derived": true,
    "name": {
      "en": "Artist +1",
      "fr": "+1 artiste",
      "nl": "+1 artiest"
    },
    "arrival": {
      "en": "",
      "fr": "",
      "nl": ""
    }
  }
];

export const COPY = {
  "title": {
    "en": "Register for your pass",
    "fr": "Inscrivez-vous pour recevoir votre pass",
    "nl": "Registreer voor je pas"
  },
  "intro": {
    "en": "It takes one minute. One form per person.",
    "fr": "Cela prend une minute. Un formulaire par personne.",
    "nl": "Het duurt één minuut. Eén formulier per persoon."
  },
  "first": {
    "en": "First name",
    "fr": "Prénom",
    "nl": "Voornaam"
  },
  "last": {
    "en": "Last name",
    "fr": "Nom",
    "nl": "Achternaam"
  },
  "email": {
    "en": "Email",
    "fr": "E-mail",
    "nl": "E-mail"
  },
  "phone": {
    "en": "WhatsApp number",
    "fr": "Numéro WhatsApp",
    "nl": "WhatsApp-nummer"
  },
  "role": {
    "en": "Your role or act",
    "fr": "Votre rôle ou numéro",
    "nl": "Je rol of act"
  },
  "child": {
    "en": "Child's name",
    "fr": "Nom de l'enfant",
    "nl": "Naam van het kind"
  },
  "dob": {
    "en": "Child's date of birth",
    "fr": "Date de naissance de l'enfant",
    "nl": "Geboortedatum van het kind"
  },
  "dob_why": {
    "en": "Used only to register child artists for the festival.",
    "fr": "Utilisée uniquement pour l'inscription des enfants artistes au festival.",
    "nl": "Wordt alleen gebruikt om kindartiesten voor het festival te registreren."
  },
  "dob_invalid": {
    "en": "Please check the date of birth.",
    "fr": "Veuillez vérifier la date de naissance.",
    "nl": "Controleer de geboortedatum."
  },
  "parent": {
    "en": "Parent or guardian",
    "fr": "Parent ou tuteur",
    "nl": "Ouder of voogd"
  },
  "consent": {
    "en": "Art India may contact me by email and WhatsApp about my pass and the festival, and keeps my details to reach me for future Art India events. I can ask to be removed at any time: diwali@artindia.be",
    "fr": "Art India peut me contacter par e-mail et WhatsApp au sujet de mon pass et du festival, et conserve mes coordonnées pour me joindre lors de ses prochains événements. Je peux demander leur suppression à tout moment : diwali@artindia.be",
    "nl": "Art India mag mij via e-mail en WhatsApp contacteren over mijn pas en het festival, en bewaart mijn gegevens om mij te bereiken voor volgende evenementen van Art India. Ik kan op elk moment vragen om ze te verwijderen: diwali@artindia.be"
  },
  "submit": {
    "en": "Register",
    "fr": "S'inscrire",
    "nl": "Registreren"
  },
  "another": {
    "en": "Register another person",
    "fr": "Inscrire une autre personne",
    "nl": "Nog iemand registreren"
  },
  "inactive": {
    "en": "This link is not active. Please contact the person who sent it to you.",
    "fr": "Ce lien n'est pas actif. Contactez la personne qui vous l'a envoyé.",
    "nl": "Deze link is niet actief. Neem contact op met de persoon die hem stuurde."
  },
  "closed": {
    "en": "Registration is closed. Please contact your team lead.",
    "fr": "Les inscriptions sont clôturées. Contactez votre responsable d'équipe.",
    "nl": "De registratie is gesloten. Neem contact op met je teamverantwoordelijke."
  },
  "mail_received_subject": {
    "en": "We received your registration",
    "fr": "Nous avons bien reçu votre inscription",
    "nl": "We hebben je registratie ontvangen"
  },
  "mail_approved_subject": {
    "en": "Your pass for the Brussels Diwali Festival",
    "fr": "Votre pass pour le Brussels Diwali Festival",
    "nl": "Je pas voor het Brussels Diwali Festival"
  },
  "error": {
    "en": "Something went wrong. Please try again.",
    "fr": "Une erreur s'est produite. Veuillez réessayer.",
    "nl": "Er ging iets mis. Probeer het opnieuw."
  },
  "wall_invite": {
    "en": "PLACEHOLDER: People of Art India photo invitation. {LINK}",
    "fr": "",
    "nl": ""
  },
  "btn_my_pass": {
    "en": "My pass",
    "fr": "Mon pass",
    "nl": "Mijn pas"
  },
  "btn_my_code": {
    "en": "My code",
    "fr": "Mon code",
    "nl": "Mijn code"
  },
  "btn_code_sales": {
    "en": "Tickets sold",
    "fr": "Billets vendus",
    "nl": "Tickets verkocht"
  },
  "bot_pass": {
    "en": "{PASS}. Your QR ticket is in your email, at {EMAIL}.",
    "fr": "{PASS}. Votre billet avec QR code se trouve dans votre boîte e-mail, à l'adresse {EMAIL}.",
    "nl": "{PASS}. Je ticket met QR-code zit in je mailbox, op {EMAIL}."
  },
  "bot_plus1_open": {
    "en": "Your +1 is not taken yet. Send them this link to register: {LINK}",
    "fr": "Votre +1 n'est pas encore inscrit. Envoyez-lui ce lien pour s'inscrire : {LINK}",
    "nl": "Je +1 is nog niet geregistreerd. Stuur deze link om te registreren: {LINK}"
  },
  "bot_plus1_pending": {
    "en": "Your +1 is registered and waiting for approval.",
    "fr": "Votre +1 est inscrit et en attente de validation.",
    "nl": "Je +1 is geregistreerd en wacht op goedkeuring."
  },
  "bot_plus1_approved": {
    "en": "Your +1 is approved: {NAME}.",
    "fr": "Votre +1 est validé : {NAME}.",
    "nl": "Je +1 is goedgekeurd: {NAME}."
  },
  "bot_code": {
    "en": "Your personal code is {CODE} and your link is {LINK}. The next message is ready to forward to friends and family.",
    "fr": "Votre code personnel est {CODE} et votre lien est {LINK}. Le message suivant est prêt à être transféré à vos proches.",
    "nl": "Je persoonlijke code is {CODE} en je link is {LINK}. Het volgende bericht kun je zo doorsturen naar vrienden en familie."
  },
  "bot_code_forward": {
    "en": "Join me at the Brussels Diwali Festival on 24 and 25 October at the Atomium. With my code {CODE} you get 10% off your ticket: {LINK}",
    "fr": "Rejoignez-moi au Brussels Diwali Festival, les 24 et 25 octobre à l'Atomium. Avec mon code {CODE}, vous avez 10 % de réduction sur votre billet : {LINK}",
    "nl": "Kom met mij naar het Brussels Diwali Festival, op 24 en 25 oktober aan het Atomium. Met mijn code {CODE} krijg je 10% korting op je ticket: {LINK}"
  },
  "bot_sales": {
    "en": "Orders with your code so far: {ORDERS}.",
    "fr": "Commandes passées avec votre code à ce jour : {ORDERS}.",
    "nl": "Bestellingen met je code tot nu toe: {ORDERS}."
  },
  "bot_sales_none": {
    "en": "No orders with your code yet.",
    "fr": "Aucune commande avec votre code pour l'instant.",
    "nl": "Nog geen bestellingen met je code."
  },
  "bot_sales_unknown": {
    "en": "I can't see the count for your code right now. Please try again later.",
    "fr": "Je ne peux pas voir le nombre de commandes pour votre code pour le moment. Réessayez plus tard.",
    "nl": "Ik kan het aantal bestellingen voor je code nu niet zien. Probeer het later opnieuw."
  },
  "bot_pending": {
    "en": "Your registration is waiting for approval by the festival team.",
    "fr": "Votre inscription est en attente de validation par l'équipe du festival.",
    "nl": "Je registratie wacht op goedkeuring door het festivalteam."
  },
  "email_hint": {
    "en": "Your pass is sent to this address.",
    "fr": "Votre pass sera envoyé à cette adresse.",
    "nl": "Je pas wordt naar dit adres gestuurd."
  },
  "phone_hint": {
    "en": "With the country code, for example +32.",
    "fr": "Avec l'indicatif du pays, par exemple +32.",
    "nl": "Met de landcode, bijvoorbeeld +32."
  },
  "fine": {
    "en": "Passes are sent after approval by the festival team.",
    "fr": "Les pass sont envoyés après validation par l'équipe du festival.",
    "nl": "Passen worden verstuurd na goedkeuring door het festivalteam."
  },
  "done_title": {
    "en": "Thank you, {FIRST}",
    "fr": "Merci, {FIRST}",
    "nl": "Bedankt, {FIRST}"
  },
  "done_lede": {
    "en": "We have received your registration.",
    "fr": "Nous avons bien reçu votre inscription.",
    "nl": "We hebben je registratie ontvangen."
  },
  "step1_title": {
    "en": "We review your registration",
    "fr": "Nous examinons votre inscription",
    "nl": "We bekijken je registratie"
  },
  "step1_text": {
    "en": "The festival team approves every pass.",
    "fr": "L'équipe du festival valide chaque pass.",
    "nl": "Het festivalteam keurt elke pas goed."
  },
  "step2_title": {
    "en": "Your pass arrives by email",
    "fr": "Votre pass arrive par e-mail",
    "nl": "Je pas komt per e-mail"
  },
  "step2_text": {
    "en": "With a QR code to show at the entrance.",
    "fr": "Avec un QR code à présenter à l'entrée.",
    "nl": "Met een QR-code om aan de ingang te tonen."
  },
  "step3_title": {
    "en": "You get a personal code to share",
    "fr": "Vous recevez un code personnel à partager",
    "nl": "Je krijgt een persoonlijke code om te delen"
  },
  "step3_text": {
    "en": "By email and WhatsApp. Your friends and family get 10% off individual festival tickets with it.",
    "fr": "Par e-mail et WhatsApp. Il offre à vos proches 10 % de réduction sur les billets individuels du festival.",
    "nl": "Via e-mail en WhatsApp. Je vrienden en familie krijgen er 10% korting mee op individuele festivaltickets."
  },
  "mail_received_code": {
    "en": "Once approved, you will also receive a personal code to share: it gives your friends and family 10% off individual festival tickets.",
    "fr": "Une fois votre inscription validée, vous recevrez aussi un code personnel à partager : il offre à vos proches 10 % de réduction sur les billets individuels du festival.",
    "nl": "Na goedkeuring krijg je ook een persoonlijke code om te delen: je vrienden en familie krijgen er 10% korting mee op individuele festivaltickets."
  },
  "dateline": {
    "en": "24 and 25 October 2026 · Atomium",
    "fr": "Les 24 et 25 octobre 2026 · Atomium",
    "nl": "24 en 25 oktober 2026 · Atomium"
  },
  "c_title": {
    "en": "{FIRST} invites you to the Brussels Diwali Festival",
    "fr": "{FIRST} vous invite au Brussels Diwali Festival",
    "nl": "{FIRST} nodigt je uit op het Brussels Diwali Festival"
  },
  "c_offer": {
    "en": "10% off individual festival tickets with this code",
    "fr": "10 % de réduction sur les billets individuels du festival avec ce code",
    "nl": "10% korting op individuele festivaltickets met deze code"
  },
  "c_button": {
    "en": "Copy code and get tickets",
    "fr": "Copier le code et réserver",
    "nl": "Kopieer de code en koop tickets"
  },
  "c_hint": {
    "en": "Paste the code at checkout, under Discount code. Valid until 23 October.",
    "fr": "Collez le code au moment du paiement, dans le champ Code de réduction. Valable jusqu'au 23 octobre.",
    "nl": "Plak de code bij het afrekenen, in het veld Kortingscode. Geldig tot 23 oktober."
  },
  "c_copied": {
    "en": "Code copied",
    "fr": "Code copié",
    "nl": "Code gekopieerd"
  },
  "mail_a_subject": {
    "en": "Welcome to the 10th Brussels Diwali Festival, {FIRST}",
    "fr": "Bienvenue au 10e Brussels Diwali Festival, {FIRST}",
    "nl": "Welkom op het 10e Brussels Diwali Festival, {FIRST}"
  },
  "mail_greeting": {
    "en": "Dear {FIRST},",
    "fr": "Bonjour {FIRST},",
    "nl": "Dag {FIRST},"
  },
  "letter_core": {
    "en": "Welcome to the team of the 10th Brussels Diwali Festival. For ten years this festival has existed because people like you give it their time, their evenings and their heart. Most of what you do is never seen by the public, and none of it would happen without you.",
    "fr": "Bienvenue dans l'équipe du 10e Brussels Diwali Festival. Depuis dix ans, ce festival existe parce que des personnes comme vous lui donnent leur temps, leurs soirées et leur cœur. Le public ne voit presque rien de ce que vous faites, et rien ne serait possible sans vous.",
    "nl": "Welkom in het team van het 10e Brussels Diwali Festival. Al tien jaar bestaat dit festival omdat mensen zoals jij er hun tijd, hun avonden en hun hart in steken. Het publiek ziet bijna niets van wat je doet, en zonder jou zou er niets van gebeuren."
  },
  "letter_artist": {
    "en": "Welcome to the 10th Brussels Diwali Festival. For ten years this festival has been carried by artists who give their talent and their time to share India with Brussels. What you bring to the stage is what people take home with them.",
    "fr": "Bienvenue au 10e Brussels Diwali Festival. Depuis dix ans, ce festival est porté par des artistes qui offrent leur talent et leur temps pour partager l'Inde avec Bruxelles. Ce que vous apportez sur scène, le public l'emporte avec lui.",
    "nl": "Welkom op het 10e Brussels Diwali Festival. Al tien jaar wordt dit festival gedragen door artiesten die hun talent en hun tijd geven om India met Brussel te delen. Wat jij op het podium brengt, nemen mensen mee naar huis."
  },
  "letter_parent": {
    "en": "Welcome to the 10th Brussels Diwali Festival, and thank you for the rehearsals, the costumes, the driving and the patience. Seeing {CHILD} and the other children on that stage is one of the moments that makes this festival what it is.",
    "fr": "Bienvenue au 10e Brussels Diwali Festival, et merci pour les répétitions, les costumes, les trajets et la patience. Voir {CHILD} et les autres enfants sur cette scène fait partie des moments qui donnent à ce festival tout son sens.",
    "nl": "Welkom op het 10e Brussels Diwali Festival, en bedankt voor de repetities, de kostuums, het heen en weer rijden en het geduld. {CHILD} en de andere kinderen op dat podium zien is een van de momenten die dit festival maken tot wat het is."
  },
  "letter_close": {
    "en": "On 24 and 25 October, thousands of people will celebrate with us at the foot of the Atomium. I am proud that you are part of it, and I look forward to seeing you there.",
    "fr": "Les 24 et 25 octobre, des milliers de personnes fêteront avec nous au pied de l'Atomium. Je suis fière que vous en fassiez partie et je me réjouis de vous y retrouver.",
    "nl": "Op 24 en 25 oktober vieren duizenden mensen met ons feest aan de voet van het Atomium. Ik ben trots dat jij erbij bent en ik kijk ernaar uit je daar te zien."
  },
  "letter_close_parent": {
    "en": "On 24 and 25 October, thousands of people will celebrate with us at the foot of the Atomium. I am proud that {CHILD} is part of it, and I look forward to seeing you there.",
    "fr": "Les 24 et 25 octobre, des milliers de personnes fêteront avec nous au pied de l'Atomium. Je suis fière que {CHILD} en fasse partie et je me réjouis de vous y retrouver.",
    "nl": "Op 24 en 25 oktober vieren duizenden mensen met ons feest aan de voet van het Atomium. Ik ben trots dat {CHILD} erbij is en ik kijk ernaar uit jullie daar te zien."
  },
  "sign_thanks": {
    "en": "With gratitude,",
    "fr": "Avec toute ma gratitude,",
    "nl": "Met veel dank,"
  },
  "sign_role": {
    "en": "Founder & Artistic Director, Art India",
    "fr": "Fondatrice et directrice artistique, Art India",
    "nl": "Oprichter en artistiek directeur, Art India"
  },
  "pass_heading": {
    "en": "Your pass",
    "fr": "Votre pass",
    "nl": "Je pas"
  },
  "pass_line": {
    "en": "{TEAM}. Your QR code is below and attached to this email. Show it on your phone at the gate.",
    "fr": "{TEAM}. Votre QR code se trouve ci-dessous et en pièce jointe. Présentez-le sur votre téléphone à l'entrée.",
    "nl": "{TEAM}. Je QR-code staat hieronder en zit als bijlage bij deze e-mail. Toon hem op je telefoon aan de ingang."
  },
  "pass_line_child": {
    "en": "This pass is for {CHILD}. The QR code is below and attached to this email. Show it on your phone at the gate. Family members coming to watch need a festival ticket, and your personal code gives them 10% off.",
    "fr": "Ce pass est celui de {CHILD}. Le QR code se trouve ci-dessous et en pièce jointe. Présentez-le sur votre téléphone à l'entrée. Les membres de la famille qui viennent assister au spectacle ont besoin d'un billet festival, et votre code personnel leur offre 10 % de réduction.",
    "nl": "Deze pas is voor {CHILD}. De QR-code staat hieronder en zit als bijlage bij deze e-mail. Toon hem op je telefoon aan de ingang. Familieleden die komen kijken hebben een festivalticket nodig, en met je persoonlijke code krijgen ze 10% korting."
  },
  "code_heading": {
    "en": "Your personal code: {CODE}",
    "fr": "Votre code personnel : {CODE}",
    "nl": "Je persoonlijke code: {CODE}"
  },
  "code_line": {
    "en": "Share it with friends and family. It gives them 10% off individual festival tickets until 23 October.",
    "fr": "Partagez-le avec vos proches. Il leur offre 10 % de réduction sur les billets individuels du festival jusqu'au 23 octobre.",
    "nl": "Deel hem met vrienden en familie. Ze krijgen er 10% korting mee op individuele festivaltickets tot 23 oktober."
  },
  "link_line": {
    "en": "Or simply send them your link: {LINK}",
    "fr": "Ou envoyez-leur simplement votre lien : {LINK}",
    "nl": "Of stuur hen gewoon je link: {LINK}"
  },
  "guest_heading": {
    "en": "Your guest",
    "fr": "Votre invité(e)",
    "nl": "Je gast"
  },
  "guest_line": {
    "en": "You may bring one guest. Send them this link to register. It works once: {LINK}",
    "fr": "Vous pouvez inviter une personne. Envoyez-lui ce lien pour s'inscrire. Il ne fonctionne qu'une fois : {LINK}",
    "nl": "Je mag één gast meebrengen. Stuur deze link om te registreren. Hij werkt één keer: {LINK}"
  },
  "questions": {
    "en": "Questions? Write to diwali@artindia.be.",
    "fr": "Une question ? Écrivez à diwali@artindia.be.",
    "nl": "Vragen? Mail naar diwali@artindia.be."
  },
  "mail_b_confirm": {
    "en": "Your pass for the 10th Brussels Diwali Festival is confirmed: {TEAM}. Thank you for being part of it.",
    "fr": "Votre pass pour le 10e Brussels Diwali Festival est confirmé : {TEAM}. Merci d'en faire partie.",
    "nl": "Je pas voor het 10e Brussels Diwali Festival is bevestigd: {TEAM}. Bedankt dat je erbij bent."
  },
  "mail_b_when": {
    "en": "The festival takes place on 24 and 25 October 2026 at the Atomium, Brussels. Your QR code is below and attached to this email. Show it on your phone at the gate.",
    "fr": "Le festival a lieu les 24 et 25 octobre 2026 à l'Atomium, à Bruxelles. Votre QR code se trouve ci-dessous et en pièce jointe. Présentez-le sur votre téléphone à l'entrée.",
    "nl": "Het festival vindt plaats op 24 en 25 oktober 2026 aan het Atomium in Brussel. Je QR-code staat hieronder en zit als bijlage bij deze e-mail. Toon hem op je telefoon aan de ingang."
  },
  "mail_received_body": {
    "en": "Thank you for registering for the 10th Brussels Diwali Festival. Your registration is with the festival team for approval, and you will hear from us by email and WhatsApp.",
    "fr": "Merci pour votre inscription au 10e Brussels Diwali Festival. Elle est entre les mains de l'équipe du festival pour validation, et vous recevrez une réponse par e-mail et WhatsApp.",
    "nl": "Bedankt voor je registratie voor het 10e Brussels Diwali Festival. Ze ligt nu bij het festivalteam ter goedkeuring, en je hoort van ons via e-mail en WhatsApp."
  }
};
