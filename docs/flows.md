# Flows — QRMeet

## Overview

QRMeet is a networking game for in-person events. Participants scan each other's QR codes to start timed conversations. When the timer ends, they scan each other again to confirm the meeting and earn a point.

---

## App activation — User journey

```mermaid
graph LR
    A[Opens /] --> SA{Standalone PWA with session?}
    SA -- Yes --> CardView
    SA -- No --> Landing

    B[Opens /r/roomId] --> HS{Has session for this room?}
    HS -- Yes --> CardView
    HS -- No --> Join[Join as new user] --> CardView

    C[Opens scan URL] --> DR{Different room?}
    DR -- Yes --> Landing
    DR -- No --> HS2{Has session?}
    HS2 -- Yes --> CardView
    HS2 -- No --> AutoJoin[Auto-join] --> CardView

    Landing --> CardView
```

---

## Client-side app states

```mermaid
stateDiagram-v2
    [*] --> Landing

    Landing --> Card : joinRoom() or resumeSession()

    state Card {
        [*] --> QRDisplayed
        QRDisplayed --> SessionActive : Receives session_start (WS)
        SessionActive --> TimerExpired : timer reaches zero
        TimerExpired --> QRDisplayed : session confirmed
        SessionActive --> QRDisplayed : session confirmed
    }

    Card --> Scanner : Camera button or scan URL
    Scanner --> Card : Scan success / error

    Card --> Score : Score tab
    Score --> Card : Card tab
```

---

## Encounter system — Activity diagram

```mermaid
graph TD
    A[User A displays QR] --> B[User B opens QR scan URL]
    B --> ROOM{Same room?}
    ROOM -- No --> ERR0[This person is in a different room]
    ROOM -- Yes --> REG{User B has a session?}
    REG -- No --> AUTOREG[Auto-join, random name and emoji assigned]
    REG -- Yes --> C{Valid QR token?}
    AUTOREG --> C
    C -- No --> ERR1[Invalid or expired QR]
    C -- Yes --> D{Existing encounter between A and B?}

    D -- No --> E[Create encounter]
    E --> F[Burn QR token]
    F --> G[Notify DurableRoom]
    G --> H[Start timer]
    H --> I[WebSocket push to both users]
    I --> CONV[Conversation in progress]

    D -- Yes --> J{encounter.counted == 1?}
    J -- Yes --> ERR2[Already confirmed]

    J -- No --> K{encounter.notified_at set?}
    K -- No --> ERR3[Session in progress, come back after the timer]

    K -- Yes --> L[Burn QR token]
    L --> M[Mark counted = 1]
    M --> N[Notify session_confirmed via WebSocket]
    N --> DONE[+1 point for both]

    CONV --> TIMER[DO alarm fires]
    TIMER --> NOTIFY[Notify A and B via session_end]
    NOTIFY --> WAIT[Waiting for re-scan to confirm]
    WAIT --> B
```

---

## Encounter lifecycle

```mermaid
stateDiagram-v2
    [*] --> Created : First scan (A scans B)

    Created --> Active : DurableRoom notified
    note right of Active : Timer running, WebSocket push to both users

    Active --> Notified : DurableRoom alarm (timer expired)
    note right of Notified : notified_at set, clients alerted

    Notified --> Confirmed : Second scan (B scans A or A scans B)
    note right of Confirmed : counted=1, closed_at set, +1 point each

    Confirmed --> [*]
```

---

## QR token lifecycle

```mermaid
stateDiagram-v2
    [*] --> Generated : POST /qr-token

    Generated --> Cached : Stored in KV (TTL 1h) + client localStorage

    Cached --> Displayed : QR code rendered on card

    Displayed --> Consumed : Successful scan (started or confirmed)
    note right of Consumed : Deleted from KV and localStorage

    Displayed --> Expired : TTL 1h elapsed
    note right of Expired : KV auto-delete

    Displayed --> Displayed : Page refresh (reuses localStorage)

    Consumed --> [*]
    Expired --> [*]

    Consumed --> Regenerated : forceRefreshQrToken()
    Regenerated --> Cached
```

---

## Full encounter sequence

```mermaid
sequenceDiagram
    participant A as User A (mobile)
    participant S as Worker API
    participant DO as DurableRoom
    participant B as User B (mobile)

    Note over A: Connected to DurableRoom via WS
    Note over B: Connected to DurableRoom via WS

    Note over A: Displays QR code

    B->>S: POST /scan {scanneeId: A, qrToken}
    S->>S: Verify KV token ✓
    S->>S: Create encounter (A,B)
    S->>S: Burn KV token
    S->>DO: POST /start-encounter
    DO->>DO: Store encounter, set alarm
    DO-->>A: session_start {partner: B, endsAt}
    DO-->>B: session_start {partner: A, endsAt}
    S-->>B: 200 {action: "started", partner: A}

    Note over A,B: 💬 Conversation (timer running)

    DO->>DO: ⏰ Alarm fires
    DO->>S: UPDATE encounters SET notified_at
    DO-->>A: session_end
    DO-->>B: session_end

    Note over A,B: 📱 Vibration + sound

    A->>S: POST /scan {scanneeId: B, qrToken}
    S->>S: Verify encounter.notified_at ✓
    S->>S: SET counted=1, closed_at
    S->>DO: POST /confirm-encounter
    DO-->>A: session_confirmed
    DO-->>B: session_confirmed
    S-->>A: 200 {action: "confirmed"}

    Note over A,B: ✅ +1 point each
```

---

## Server state summary

| State | `started_at` | `notified_at` | `closed_at` | `counted` | Meaning |
|-------|:---:|:---:|:---:|:---:|---|
| Active | ✓ | — | — | 0 | Timer running, conversation |
| Notified | ✓ | ✓ | — | 0 | Timer expired, awaiting confirmation |
| Confirmed | ✓ | ✓ | ✓ | 1 | Meeting validated, points awarded |
