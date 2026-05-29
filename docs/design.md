# Design — QRMeet

## Vue d'ensemble

QRMeet est un jeu de networking en événement. Les participants scannent les QR codes des autres pour initier des conversations minutées. Après le timer, ils se re-scannent pour confirmer la rencontre et gagner un point.

---

## Activation de l'app — Parcours utilisateur

```mermaid
stateDiagram-v2
    [*] --> Landing : Ouvre l'URL /

    state Landing {
        [*] --> ChoixInitial
        ChoixInitial --> Rejoindre : Saisit un code room
        ChoixInitial --> Créer : Crée une room
        ChoixInitial --> Reprendre : Session existante (localStorage)
    }

    state "Lancement app installée" as Standalone {
        [*] --> EntréeDirecte : Session en localStorage
        [*] --> Landing : Pas de session
    }

    Landing --> Inscription : POST /api/rooms/:id/users
    Reprendre --> CardView : Credentials en localStorage

    Inscription --> ProfilAléatoire : Emoji aléatoire assigné
    ProfilAléatoire --> CardView : Profil persisté

    CardView --> [*]
```

---

## États de l'app côté client

```mermaid
stateDiagram-v2
    [*] --> Landing

    Landing --> Card : joinRoom() ou resumeSession()

    state Card {
        [*] --> QRAffiché
        QRAffiché --> SessionActive : Reçoit session_start (WS)
        SessionActive --> TimerExpiré : sessionSecondsLeft <= 0
        TimerExpiré --> QRAffiché : session confirmée
        SessionActive --> QRAffiché : session confirmée
    }

    Card --> Scanner : Bouton 📷 ou scan URL
    Scanner --> Card : Scan réussi / erreur

    Card --> Score : Onglet Score
    Score --> Card : Onglet Card
```

---

## Système de rencontre — Diagramme d'activité

```mermaid
flowchart TD
    A[User A affiche son QR] --> B[User B scanne le QR de A]
    B --> ROOM{Même room ?}
    ROOM -- Non --> ERR0[Erreur : This person is in a different room]
    ROOM -- Oui --> C{Token QR valide ?}
    C -- Non --> ERR1[Erreur : QR invalide ou expiré]
    C -- Oui --> D{Encounter existant entre A et B ?}

    D -- Non --> E[Créer encounter]
    E --> F[Burn token QR]
    F --> G[Notifier DurableRoom]
    G --> H[Démarrer timer]
    H --> I[Push WebSocket aux deux users : session_start]
    I --> CONV[💬 Conversation en cours]

    D -- Oui --> J{encounter.counted == 1 ?}
    J -- Oui --> ERR2[Erreur : Déjà confirmé]

    J -- Non --> K{encounter.notified_at set ?}
    K -- Non --> ERR3[Erreur : Session en cours, revenez après le timer]

    K -- Oui --> L[Burn token QR]
    L --> M[Marquer counted = 1]
    M --> N[Notifier via WebSocket : session_confirmed]
    N --> DONE[✅ +1 point pour les deux]

    CONV --> TIMER[⏰ Alarme DO : timer expiré]
    TIMER --> NOTIFY[Notifier A et B : session_end]
    NOTIFY --> WAIT[Attente re-scan pour confirmation]
    WAIT --> B
```

---

## Cycle de vie d'un Encounter

```mermaid
stateDiagram-v2
    [*] --> Created : Premier scan (A scanne B)

    Created --> Active : DurableRoom notifié
    note right of Active : Timer en cours\nWebSocket push instantané\nLes deux users discutent

    Active --> Notified : Alarme DurableRoom (timer expiré)
    note right of Notified : notified_at set\nClients alertés\nEn attente de confirmation

    Notified --> Confirmed : Second scan (B scanne A ou A scanne B)
    note right of Confirmed : counted = 1\nclosed_at set\n+1 point chacun

    Confirmed --> [*]
```

---

## Cycle de vie d'un QR Token

```mermaid
stateDiagram-v2
    [*] --> Généré : POST /qr-token

    Généré --> EnCache : Stocké en KV (TTL 1h)\n+ localStorage client

    EnCache --> Affiché : QR code rendu sur la card

    Affiché --> Consommé : Scan réussi (started ou confirmed)
    note right of Consommé : Supprimé du KV\nSupprimé du localStorage

    Affiché --> Expiré : TTL 1h dépassé
    note right of Expiré : KV auto-delete

    Affiché --> Affiché : Refresh page (réutilise localStorage)

    Consommé --> [*]
    Expiré --> [*]

    Consommé --> Régénéré : forceRefreshQrToken()
    Régénéré --> EnCache
```

---

## Séquence complète d'une rencontre

```mermaid
sequenceDiagram
    participant A as User A (mobile)
    participant S as Worker API
    participant DO as DurableRoom
    participant B as User B (mobile)

    Note over A: Connecté au DurableRoom via WS
    Note over B: Connecté au DurableRoom via WS

    Note over A: Affiche QR code

    B->>S: POST /scan {scanneeId: A, qrToken}
    S->>S: Vérifie token KV ✓
    S->>S: Crée encounter (A,B)
    S->>S: Burn token KV
    S->>DO: POST /start-encounter
    DO->>DO: Stocke encounter, set alarm
    DO-->>A: session_start {partner: B, endsAt}
    DO-->>B: session_start {partner: A, endsAt}
    S-->>B: 200 {action: "started", partner: A}

    Note over A,B: 💬 Conversation (timer en cours)

    DO->>DO: ⏰ Alarm fires
    DO->>S: UPDATE encounters SET notified_at
    DO-->>A: session_end
    DO-->>B: session_end

    Note over A,B: 📱 Vibration + son

    A->>S: POST /scan {scanneeId: B, qrToken}
    S->>S: Vérifie encounter.notified_at ✓
    S->>S: SET counted=1, closed_at
    S->>DO: POST /confirm-encounter
    DO-->>A: session_confirmed
    DO-->>B: session_confirmed
    S-->>A: 200 {action: "confirmed"}

    Note over A,B: ✅ +1 point chacun
```

---

## Résumé des états serveur

| État | `started_at` | `notified_at` | `closed_at` | `counted` | Signification |
|------|:---:|:---:|:---:|:---:|---|
| Active | ✓ | — | — | 0 | Timer en cours, conversation |
| Notified | ✓ | ✓ | — | 0 | Timer expiré, en attente de confirmation |
| Confirmed | ✓ | ✓ | ✓ | 1 | Rencontre validée, points attribués |
