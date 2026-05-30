/**
 * MIT License
 *
 * Copyright (c) 2026 Vincent Hiribarren
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { storage } from './storage.js'

// Dependencies are loaded from CDN in index.html:
//   - `qrcode` (qrcode-generator UMD) is exposed as a global
//   - emoji-picker-element registers the <emoji-picker> custom element
//   - Alpine.js is loaded via <script defer>

// Large pool of emojis for random assignment
const RANDOM_EMOJIS = [
  // Faces
  '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😉','😊','😇','🥰','😍','🤩','😘',
  '😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🫡','🤐','🤨','😐','😑','😶',
  '🫥','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮',
  '🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐',
  // Animals
  '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈',
  '🙉','🙊','🐒','🐔','🐧','🐦','🐤','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝',
  '🪱','🐛','🦋','🐌','🐞','🐜','🪰','🪲','🪳','🦟','🦗','🕷','🦂','🐢','🐍','🦎',
  '🦖','🦕','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅',
  '🐆','🦓','🦍','🦧','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🦬','🐃','🐂','🐄','🐎',
  '🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🦮','🐈','🐓','🦃','🦤','🦚','🦜','🦢',
  '🦩','🕊','🐇','🦝','🦨','🦡','🦫','🦦','🦥','🐁','🐀','🐿','🦔',
  // Nature
  '🌵','🎄','🌲','🌳','🌴','🪵','🌱','🌿','☘️','🍀','🎍','🪴','🎋','🍃','🍂','🍁',
  '🪺','🪹','🍄','🌾','💐','🌷','🌹','🥀','🌺','🌸','🌼','🌻','🌞','🌝','🌛','🌜',
  '🌚','🌕','🌖','🌗','🌘','🌑','🌒','🌓','🌔','🌙','🌎','🌍','🌏','🪐','💫','⭐',
  '🌟','✨','⚡','☄️','💥','🔥','🌪','🌈','☀️','🌤','⛅','🌥','☁️','🌦','🌧','⛈',
  '🌩','🌨','❄️','☃️','⛄','🌬','💨','💧','💦','🫧','☔','☂️','🌊','🌫',
  // Food
  '🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥',
  '🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶','🫑','🌽','🥕','🫒','🧄','🧅','🥔','🍠',
  '🫘','🥐','🥯','🍞','🥖','🥨','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖',
  '🦴','🌭','🍔','🍟','🍕','🫓','🥪','🥙','🧆','🌮','🌯','🫔','🥗','🥘','🫕','🥫',
  '🍝','🍜','🍲','🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥠','🥮','🍢',
  '🍡','🍧','🍨','🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰',
  '🥜','🍯','🥛','🍼','🫖','☕','🍵','🧃','🥤','🧋','🍶','🍺','🍻','🥂','🍷','🥃',
  // Activities & objects
  '⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🪀','🏓','🏸','🏒','🏑','🥍',
  '🏏','🪃','🥅','⛳','🪁','🏹','🎣','🤿','🥊','🥋','🎽','🛹','🛼','🛷','⛸','🥌',
  '🎿','⛷','🏂','🪂','🏋️','🎪','🎭','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🪘','🎷',
  '🎺','🪗','🎸','🪕','🎻','🎲','♟','🎯','🎳','🎮','🎰','🧩',
  '🚀','🛸','🌍','💎','🔮','🧲','🪄','🎩','🧸','🪆','🎁','🎀','🎊','🎉','🎈',
]

function randomEmoji() {
  return RANDOM_EMOJIS[Math.floor(Math.random() * RANDOM_EMOJIS.length)]
}

// Safe fetch that always returns { ok, data, error }
async function apiFetch(url, options = {}) {
  const res = await fetch(url, options)
  let data
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    data = await res.json()
  } else {
    const text = await res.text()
    data = { error: text || `HTTP ${res.status}` }
  }
  return { ok: res.ok, status: res.status, data }
}

function qrmeet() {
  return {
    // ── State ──
    page: 'landing',
    me: null,           // { publicId, privateToken, displayName, emoji }
    roomId: null,
    scoreData: null,
    session: null,      // active session info
    sessionSecondsLeft: 0,
    sessionTimer: null,
    pendingSessions: [],

    // Landing
    joinMode: false,
    joinCode: '',
    showCreateRoom: false,
    createName: '',
    createPassword: '',
    createdRoom: null,
    savedSession: null, // existing session from localStorage

    // Card
    editingName: false,
    nameInput: '',
    showEmojiPicker: false,
    qrReady: false,
    qrToken: null,
    qrDataUrl: null,

    // Scan
    scanState: 'scanning',
    scanError: '',
    scannerOpen: false,
    scannerStream: null,

    // Toast
    toast: null,
    toastTimer: null,

    // WebSocket
    ws: null,
    wsReconnectTimer: null,

    // Emoji palette
    emojis: [], // no longer used — emoji-picker-element handles this

    // ── Init ──
    async init() {
      // Check URL for scan or room
      const path = location.pathname

      // Handle scan URL: /r/:roomId/scan/:publicId?t=token
      const scanMatch = path.match(/^\/r\/([^/]+)\/scan\/([^/]+)$/)
      if (scanMatch) {
        const [, roomId, scanneePublicId] = scanMatch
        const qrToken = new URLSearchParams(location.search).get('t')

        // Check if user is already in a different room
        const saved = this.loadSaved()
        if (saved?.roomId && saved.roomId !== roomId) {
          this.me = saved.me
          this.roomId = saved.roomId
          this.savedSession = saved
          this.page = 'landing'
          this.showToast('This QR is from a different room. Switch rooms first.')
          return
        }

        this.roomId = roomId
        this.page = 'scan'
        this.scanState = 'scanning'
        await this.ensureUser()
        await this.doScan(scanneePublicId, qrToken)
        return
      }

      // Handle room URL: /r/:roomId
      const roomMatch = path.match(/^\/r\/([^/]+)$/)
      if (roomMatch) {
        this.joinCode = roomMatch[1]
        await this.joinRoom()
        return
      }

      // Check localStorage for existing session
      const saved = this.loadSaved()
      if (saved) {
        this.me = saved.me
        this.roomId = saved.roomId
        // If launched as installed app (standalone), go straight to room
        const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone
        if (isStandalone) {
          await this.enterRoom()
          return
        }
        this.savedSession = saved
        this.page = 'landing'
        return
      }

      this.page = 'landing'
    },

    // ── Storage ──
    loadSaved() {
      const publicId    = storage.get('publicId')
      const privateToken = storage.get('privateToken')
      const roomId      = storage.get('roomId')
      if (!publicId || !privateToken || !roomId) return null
      return {
        me: {
          publicId,
          privateToken,
          displayName: storage.get('displayName') || 'Anonymous',
          emoji:       storage.get('emoji') || '😊',
        },
        roomId,
      }
    },

    save() {
      if (!this.me || !this.roomId) return
      storage.set('publicId',    this.me.publicId)
      storage.set('privateToken', this.me.privateToken)
      storage.set('roomId',      this.roomId)
      storage.set('displayName', this.me.displayName || 'Anonymous')
      storage.set('emoji',       this.me.emoji || '😊')
    },

    clearSaved() {
      storage.clearSession()
    },

    // ── Room management ──
    async createRoom() {
      if (this.createPassword.length < 4) return
      try {
        const passwordHash = await this.hashPassword(this.createPassword)
        const { ok, data } = await apiFetch('/api/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.createName || 'QRMeet', adminPassword: passwordHash }),
        })
        if (!ok) throw new Error(data.error)
        storage.set('adminPassword', passwordHash)
        this.createdRoom = data
      } catch (e) {
        this.showToast(e.message)
      }
    },

    async resumeSession() {
      if (!this.savedSession) return
      this.me = this.savedSession.me
      this.roomId = this.savedSession.roomId
      await this.enterRoom()
    },

    switchRoom() {
      if (!confirm('This will disconnect you from your current room. If you rejoin later, you\'ll start with a new profile and lose your score. Continue?')) return
      // Close WebSocket
      if (this.ws) { try { this.ws.close() } catch {} }
      clearTimeout(this.wsReconnectTimer)
      clearInterval(this.sessionTimer)
      // Reset state
      this.savedSession = null
      this.me = null
      this.roomId = null
      this.session = null
      this.scoreData = null
      this.qrReady = false
      this.clearSaved()
      history.replaceState({}, '', '/')
      this.page = 'landing'
    },

    async joinRoom(code) {
      const roomId = (code ?? this.joinCode).trim().toLowerCase()
      if (!roomId) return
      this.roomId = roomId

      // Check if we already have credentials for this room
      const saved = this.loadSaved()
      if (saved?.roomId === roomId && saved?.me) {
        this.me = saved.me
        await this.enterRoom()
        return
      }

      // Join as new user
      try {
        const { ok, data } = await apiFetch(`/api/rooms/${roomId}/users`, { method: 'POST' })
        if (!ok) throw new Error(data.error || 'Could not join room')
        const emoji = randomEmoji()
        this.me = { publicId: data.publicId, privateToken: data.privateToken, displayName: data.displayName, emoji }
        this.save()
        // Persist random emoji to server
        await this.updateProfile({ emoji })
        await this.enterRoom()
      } catch (e) {
        this.showToast(e.message)
      }
    },

    async enterRoom() {
      await this.loadScore()
      this.page = 'card'
      await this.refreshQrToken()
      this.connectWs()
      history.replaceState({}, '', `/r/${this.roomId}`)
    },

    async ensureUser() {
      const saved = this.loadSaved()
      if (saved?.roomId === this.roomId && saved?.me) {
        this.me = saved.me
        return
      }
      const { ok, data } = await apiFetch(`/api/rooms/${this.roomId}/users`, { method: 'POST' })
      if (!ok) throw new Error(data.error || 'Could not join room')
      const emoji = randomEmoji()
      this.me = { publicId: data.publicId, privateToken: data.privateToken, displayName: data.displayName, emoji }
      this.save()
      await this.updateProfile({ emoji })
    },

    // ── Profile ──
    async saveName() {
      const name = this.nameInput.trim()
      this.editingName = false
      if (!name || name === this.me?.displayName) return
      await this.updateProfile({ displayName: name })
    },

    async pickEmoji(emoji) {
      if (!emoji || emoji === this.me?.emoji) return
      this.showEmojiPicker = false
      await this.updateProfile({ emoji })
    },

    toggleEmojiPicker() {
      this.showEmojiPicker = !this.showEmojiPicker
      this.editingName = false
    },

    async updateProfile(update) {
      if (!this.me) return
      try {
        const { ok } = await apiFetch(`/api/rooms/${this.roomId}/users/${this.me.publicId}/profile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-private-token': this.me.privateToken },
          body: JSON.stringify(update),
        })
        if (ok) {
          if (update.displayName) this.me.displayName = update.displayName
          if (update.emoji) this.me.emoji = update.emoji
          this.save()
        }
      } catch {}
    },

    // ── QR Code ──
    async refreshQrToken() {
      if (!this.me) return

      // Reuse existing token from localStorage if available
      const saved = storage.get('qrToken')
      if (saved && !this._forceNewToken) {
        this.qrToken = saved
        this._renderQr()
        return
      }
      this._forceNewToken = false

      const { ok, data } = await apiFetch(`/api/rooms/${this.roomId}/users/${this.me.publicId}/qr-token`, {
        method: 'POST',
        headers: { 'x-private-token': this.me.privateToken },
      })
      if (!ok) {
        console.error('qr-token error:', data)
        this.showToast('QR error: ' + (data.error ?? 'unknown'))
        return
      }
      this.qrToken = data.token
      storage.set('qrToken', data.token)
      this._renderQr()
    },

    forceRefreshQrToken() {
      // Clear cached token so a fresh one is fetched from the server
      storage.remove('qrToken')
      this._forceNewToken = true
      this.refreshQrToken()
    },

    _renderQr() {
      const scanUrl = `${location.origin}/r/${this.roomId}/scan/${this.me.publicId}?t=${this.qrToken}`
      const qr = qrcode(0, 'M')
      qr.addData(scanUrl)
      qr.make()
      const svg = qr.createSvgTag(8, 1)
      this.qrDataUrl = 'data:image/svg+xml;base64,' + btoa(svg)
      this.qrReady = true
    },

    // ── Scanner (camera) ──
    async openScanner() {
      this.scannerOpen = true
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }
        })
        this.scannerStream = stream
        const video = this.$refs.scannerVideo
        video.srcObject = stream
        await video.play()
        this._startDetection(video)
      } catch (e) {
        this.showToast('Camera access denied')
        this.scannerOpen = false
      }
    },

    closeScanner() {
      this.scannerOpen = false
      if (this.scannerStream) {
        this.scannerStream.getTracks().forEach(t => t.stop())
        this.scannerStream = null
      }
      if (this._scanRaf) {
        cancelAnimationFrame(this._scanRaf)
        this._scanRaf = null
      }
    },

    _startDetection(video) {
      // Use BarcodeDetector if available (Chrome, Safari 16.4+)
      if ('BarcodeDetector' in window) {
        const detector = new BarcodeDetector({ formats: ['qr_code'] })
        const scan = async () => {
          if (!this.scannerOpen) return
          try {
            const barcodes = await detector.detect(video)
            if (barcodes.length > 0) {
              this._handleScannedUrl(barcodes[0].rawValue)
              return
            }
          } catch {}
          this._scanRaf = requestAnimationFrame(scan)
        }
        this._scanRaf = requestAnimationFrame(scan)
      } else {
        // Fallback: use canvas + jsQR (loaded dynamically)
        this._startCanvasFallback(video)
      }
    },

    async _startCanvasFallback(video) {
      // Dynamically import jsQR as fallback
      if (!window.jsQR) {
        try {
          const script = document.createElement('script')
          script.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js'
          document.head.appendChild(script)
          await new Promise((resolve, reject) => { script.onload = resolve; script.onerror = reject })
        } catch {
          this.showToast('QR scanner not supported on this device')
          this.closeScanner()
          return
        }
      }
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      const scan = () => {
        if (!this.scannerOpen) return
        if (video.readyState >= video.HAVE_ENOUGH_DATA) {
          canvas.width = video.videoWidth
          canvas.height = video.videoHeight
          ctx.drawImage(video, 0, 0)
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
          const code = window.jsQR(imageData.data, canvas.width, canvas.height)
          if (code) {
            this._handleScannedUrl(code.data)
            return
          }
        }
        this._scanRaf = requestAnimationFrame(scan)
      }
      this._scanRaf = requestAnimationFrame(scan)
    },

    async _handleScannedUrl(url) {
      this.closeScanner()
      if (navigator.vibrate) navigator.vibrate(8)
      try {
        const parsed = new URL(url)

        // Room join QR: /r/{roomId}
        const roomMatch = parsed.pathname.match(/^\/r\/([^/]+)$/)
        if (roomMatch) {
          const [, roomId] = roomMatch
          this.joinCode = roomId
          this.joinRoom()
          return
        }

        // Scan QR: /r/{roomId}/scan/{publicId}?t={token}
        const scanMatch = parsed.pathname.match(/^\/r\/([^/]+)\/scan\/([^/]+)$/)
        if (scanMatch) {
          const [, roomId, scanneePublicId] = scanMatch
          const qrToken = parsed.searchParams.get('t')

          // Block cross-room scans
          if (this.roomId && roomId !== this.roomId) {
            this.showToast('This person is in a different room')
            return
          }

          this.roomId = roomId
          this.page = 'scan'
          this.scanState = 'scanning'
          try {
            await this.ensureUser()
          } catch (e) {
            this.scanState = 'error'
            this.scanError = e.message || 'Could not join room'
            return
          }
          this.doScan(scanneePublicId, qrToken)
          return
        }

        this.showToast('Not a valid QRMeet code')
      } catch {
        this.showToast('Not a valid QR code')
      }
    },

    // ── Scan ──
    async doScan(scanneePublicId, qrToken) {
      if (!qrToken) {
        this.scanState = 'error'
        this.scanError = 'Invalid QR code (missing token).'
        return
      }
      try {
        const { ok, data } = await apiFetch(`/api/rooms/${this.roomId}/scan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-private-token': this.me.privateToken },
          body: JSON.stringify({ scanneePublicId, qrToken }),
        })

        if (!ok) {
          this.scanState = 'error'
          this.scanError = data.error || 'Scan failed'
          // Redirect to room after a delay so user isn't stuck on scan page
          setTimeout(() => {
            history.replaceState({}, '', `/r/${this.roomId}`)
            this.session = null
            this.enterRoom()
          }, 3000)
          return
        }

        if (data.action === 'started') {
          const offset = (data.serverTime || Math.floor(Date.now() / 1000)) - Math.floor(Date.now() / 1000)
          this.session = {
            encounterId: data.encounterId,
            endsAt: data.endsAt - offset,
            partnerName: data.partner.displayName,
            partnerEmoji: data.partner.emoji,
            confirmed: false,
          }
          this.startSessionTimer()
          this.scanState = 'success'
          if (navigator.vibrate) navigator.vibrate(15)
          this.connectWs()
          // Redirect to room URL so the user lands in the app
          history.replaceState({}, '', `/r/${this.roomId}`)
          await this.forceRefreshQrToken()
          this.page = 'card'
        } else if (data.action === 'confirmed') {
          this.scanState = 'confirmed'
          if (navigator.vibrate) navigator.vibrate([10, 60, 20])
          if (this.session) this.session.confirmed = true
          await this.loadScore()
          await this.forceRefreshQrToken()
          // Redirect to room URL
          history.replaceState({}, '', `/r/${this.roomId}`)
          this.page = 'card'
        }
      } catch (e) {
        this.scanState = 'error'
        this.scanError = 'Network error. Please try again.'
        setTimeout(() => {
          history.replaceState({}, '', `/r/${this.roomId}`)
          this.session = null
          this.enterRoom()
        }, 3000)
      }
    },

    // ── Session timer ──
    startSessionTimer() {
      if (this.sessionTimer) clearInterval(this.sessionTimer)
      const update = () => {
        if (!this.session) { clearInterval(this.sessionTimer); return }
        this.sessionSecondsLeft = this.session.endsAt - Math.floor(Date.now() / 1000)
      }
      update()
      this.sessionTimer = setInterval(update, 1000)
    },

    // ── WebSocket ──
    connectWs() {
      if (this.ws && this.ws.readyState <= 1) return
      if (!this.me || !this.roomId) return
      clearTimeout(this.wsReconnectTimer)

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const url = `${proto}//${location.host}/api/rooms/${this.roomId}/users/${this.me.publicId}/ws`
      // The private token is passed via the WebSocket subprotocol header
      // (['qrmeet.token', <token>]) rather than the URL query string, so it
      // never appears in server access/observability logs.
      this.ws = new WebSocket(url, ['qrmeet.token', this.me.privateToken])

      this.ws.onmessage = (evt) => this.handleWsMessage(JSON.parse(evt.data))
      this.ws.onclose = () => {
        this.wsReconnectTimer = setTimeout(() => this.connectWs(), 3000)
      }
    },

    handleWsMessage(msg) {
      if (msg.type === 'connected') {
        // Connected to DurableRoom, no active session — just wait for notifications
      }

      if (msg.type === 'session_start') {
        const wasNull = !this.session
        // Calculate clock offset: server time vs local time
        const serverNow = msg.serverTime
        const localNow = Math.floor(Date.now() / 1000)
        const offset = serverNow - localNow // positive = server ahead
        this.session = {
          encounterId: msg.encounterId,
          endsAt: msg.endsAt - offset, // adjust to local clock
          partnerName: msg.partnerName,
          partnerEmoji: msg.partnerEmoji,
          confirmed: false,
        }
        this.startSessionTimer()
        this.loadScore()
        // Refresh QR token so B can scan A again for confirmation
        if (wasNull) this.forceRefreshQrToken()
      }

      if (msg.type === 'session_end') {
        this.notify()
        this.showToast('⏰ Time is up! Scan each other again to confirm.')
        this.loadScore()
      }

      if (msg.type === 'session_confirmed') {
        if (this.session) this.session.confirmed = true
        this.notify()
        this.showToast('✅ Meeting confirmed! +1 point!')
        this.session = null
        clearInterval(this.sessionTimer)
        this.loadScore()
        this.forceRefreshQrToken()
      }

      if (msg.type === 'token_refresh') {
        this.forceRefreshQrToken()
      }
    },

    // ── Notifications ──
    notify() {
      if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400])
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)()
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.frequency.setValueAtTime(880, ctx.currentTime)
        osc.frequency.setValueAtTime(660, ctx.currentTime + 0.15)
        osc.frequency.setValueAtTime(880, ctx.currentTime + 0.3)
        gain.gain.setValueAtTime(0.3, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5)
        osc.start(ctx.currentTime)
        osc.stop(ctx.currentTime + 0.5)
      } catch {}
    },

    // ── Score ──
    async loadScore() {
      if (!this.me || !this.roomId) return
      try {
        const { ok, data } = await apiFetch(`/api/rooms/${this.roomId}/users/${this.me.publicId}/score`, {
          headers: { 'x-private-token': this.me.privateToken },
        })
        if (ok) {
          this.scoreData = data
          this.pendingSessions = (data.encounters ?? []).filter(e => !e.counted && e.notified_at)
        }
      } catch {}
    },

    // ── Navigation ──
    goTo(p) {
      this.page = p
      this.showEmojiPicker = false
    },

    // ── Utilities ──
    async hashPassword(password) {
      const data = new TextEncoder().encode(password)
      const buf  = await crypto.subtle.digest('SHA-256', data)
      return btoa(String.fromCharCode(...new Uint8Array(buf)))
    },

    formatTime(seconds) {
      if (seconds <= 0) return '0:00'
      const m = Math.floor(seconds / 60)
      const s = seconds % 60
      return `${m}:${s.toString().padStart(2, '0')}`
    },

    showToast(msg) {
      this.toast = msg
      clearTimeout(this.toastTimer)
      this.toastTimer = setTimeout(() => { this.toast = null }, 3500)
    },
  }
}

// Register with Alpine (loaded from CDN) once it boots — no global needed.
document.addEventListener('alpine:init', () => Alpine.data('qrmeet', qrmeet))

// Minimal SW registration — required for PWA installability on Android Chrome.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js')
