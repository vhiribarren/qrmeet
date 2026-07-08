import { adminKeychain } from './storage.js'

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

// Turns a Unix expiry timestamp into a human-readable data-deletion notice.
function formatCountdown(expiresAt) {
  if (!expiresAt) return ''
  const secs = expiresAt - Math.floor(Date.now() / 1000)
  if (secs <= 0) return '🗑 Data has been deleted'
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  let parts
  if (d > 0)      parts = `${d}d ${h}h`
  else if (h > 0) parts = `${h}h ${m}m`
  else if (m > 0) parts = `${m}m ${s}s`
  else            parts = `${s}s`
  return `🗑 Data auto-deletes in ${parts}`
}

// Minimal HTML escaping for values injected into the print area via innerHTML.
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]))
}

function adminApp() {
  return {
    roomId: '',
    passwordInput: '',
    token: '',           // hashed credential sent to the API
    authenticated: false,
    authLoading: false,
    authError: '',
    scores: [],
    totalMeetings: 0,
    topScore: 0,
    tab: 'join',
    copied: false,
    toast: '',
    graphData: null,
    expiresAt: 0,
    countdown: '',
    _countdownTimer: null,
    roomTtlDays: 7,
    settingsName: '',
    settingsIsOpen: true,
    settingsScanningEnabled: true,
    settingsQuestionsEnabled: true,
    settingsMaxParticipants: 100,
    settingsMaxParticipantsIsDefault: true,
    settingsDuration: 300,
    settingsDurationIsDefault: true,
    settingsTreasureHuntEnabled: false,
    settingsTreasureDefaultPoints: 2,
    settingsBoardTopSize: 10,
    questions: [],
    newQuestionText: '',
    treasures: [],
    treasureDefaultPoints: 2,
    newTreasureLabel: '',
    newTreasurePoints: '',   // '' = inherit room default

    async init() {
      const match = window.location.pathname.match(/\/r\/([^/]+)\/admin/)
      if (match) this.roomId = match[1]
      this.startCountdown()
      const saved = adminKeychain.get(this.roomId)
      if (saved?.token) {
        this.token = saved.token
        await this.authenticate()
      }
    },

    // ── Data-deletion countdown ──
    startCountdown() {
      if (this._countdownTimer) clearInterval(this._countdownTimer)
      const tick = () => { this.countdown = formatCountdown(this.expiresAt) }
      tick()
      this._countdownTimer = setInterval(tick, 1000)
    },

    async hashPassword(password) {
      const data = new TextEncoder().encode(password)
      const buf  = await crypto.subtle.digest('SHA-256', data)
      return btoa(String.fromCharCode(...new Uint8Array(buf)))
    },

    async login() {
      this.token = await this.hashPassword(this.passwordInput)
      await this.authenticate()
    },

    async authenticate() {
      this.authError = ''
      this.authLoading = true
      try {
        const res = await fetch(`/api/admin/rooms/${this.roomId}/scores`, {
          headers: { 'x-admin-token': this.token }
        })
        if (!res.ok) {
          this.authError = 'Invalid password'
          this.token = ''
          return
        }
        // Add (or refresh) this room in the admin keychain. The display name is
        // filled in lazily by loadSettings(); store the code for now so the
        // /admin console can list it immediately.
        const existing = adminKeychain.get(this.roomId)
        adminKeychain.set(this.roomId, existing?.name || '', this.token)
        this.authenticated = true
        await this.loadScores()
        // Load settings eagerly so the room name is available everywhere it's
        // used (e.g. printed treasure cards), regardless of which tab is opened.
        await this.loadSettings()
        this.$nextTick(() => this.generateRoomQr())
      } catch (e) {
        this.authError = 'Connection error'
      } finally {
        this.authLoading = false
      }
    },

    async loadScores() {
      const res = await fetch(`/api/admin/rooms/${this.roomId}/scores`, {
        headers: { 'x-admin-token': this.token }
      })
      if (!res.ok) return
      const data = await res.json()
      this.scores = data.scores || []
      this.expiresAt = data.expiresAt || 0
      this.topScore = this.scores.reduce((max, u) => Math.max(max, u.score || 0), 0)
      // Server-computed over all encounters so board and admin always report the same total.
      this.totalMeetings = data.totalMeetings || 0
    },

    async loadGraph() {
      const res = await fetch(`/api/admin/rooms/${this.roomId}/graph`, {
        headers: { 'x-admin-token': this.token }
      })
      if (!res.ok) return
      this.graphData = await res.json()
      this.$nextTick(() => this.renderGraph())
    },

    renderGraph() {
      const container = document.getElementById('admin-graph')
      if (!container || !this.graphData) return
      container.innerHTML = ''

      const width = container.clientWidth
      const height = container.clientHeight || 400

      const svg = d3.select(container).append('svg')
        .attr('viewBox', `0 0 ${width} ${height}`)
      // Everything lives inside this layer so zoom/pan is a single transform.
      const layer = svg.append('g')

      const nodes = this.graphData.nodes.map(n => ({ id: n.public_id, name: n.display_name, emoji: n.emoji }))
      const links = this.graphData.edges.map(e => ({ source: e.user_a_id, target: e.user_b_id }))

      // Degree drives node size (bigger = more connections) and, via adjacency,
      // the focus/highlight interaction.
      const neighbors = new Map(nodes.map(n => [n.id, new Set([n.id])]))
      const degree = new Map(nodes.map(n => [n.id, 0]))
      this.graphData.edges.forEach(e => {
        neighbors.get(e.user_a_id)?.add(e.user_b_id)
        neighbors.get(e.user_b_id)?.add(e.user_a_id)
        degree.set(e.user_a_id, (degree.get(e.user_a_id) || 0) + 1)
        degree.set(e.user_b_id, (degree.get(e.user_b_id) || 0) + 1)
      })
      const radius = d => Math.max(6, Math.min(34, 5 + Math.sqrt(degree.get(d.id) || 0) * 4.5))

      // Adaptive layout: repulsion, collision and link length all derive from
      // node size and count, so a 200-person room spreads out instead of
      // collapsing into a ball. distanceMax caps long-range forces to keep big
      // graphs stable and fast.
      const n = nodes.length
      const spread = 1 + Math.min(2, n / 120)
      const simulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links).id(d => d.id)
          .distance(d => radius(d.source) + radius(d.target) + 26 * spread))
        .force('charge', d3.forceManyBody()
          .strength(d => -(radius(d) * 8 + 40) * spread)
          .distanceMax(Math.max(width, height)))
        .force('x', d3.forceX(width / 2).strength(0.04))
        .force('y', d3.forceY(height / 2).strength(0.04))
        .force('collide', d3.forceCollide(d => radius(d) + 4))

      const link = layer.append('g')
        .selectAll('line')
        .data(links)
        .join('line')
        .attr('stroke', '#cbd5e1')
        .attr('stroke-width', 1.5)

      const node = layer.append('g')
        .selectAll('g')
        .data(nodes)
        .join('g')
        .attr('class', 'graph__node')
        .call(d3.drag()
          .on('start', (event, d) => { event.sourceEvent.stopPropagation(); d.moved = false; if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
          .on('drag', (event, d) => { d.moved = true; d.fx = event.x; d.fy = event.y; })
          .on('end', (event, d) => { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
        )

      node.append('circle')
        .attr('r', radius)
        .attr('fill', '#eef2ff')
        .attr('stroke', '#6366f1')
        .attr('stroke-width', 2)

      node.append('text')
        .text(d => d.emoji)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .attr('class', 'graph__emoji')
        .attr('font-size', d => Math.max(10, radius(d) * 1.1) + 'px')

      // Names stay hidden until a node is focused — showing 200 labels at once
      // is what makes the graph unreadable in the first place.
      const label = node.append('text')
        .text(d => d.name)
        .attr('text-anchor', 'middle')
        .attr('class', 'graph__label')
        .attr('dy', d => radius(d) + 12)
        .attr('opacity', 0)

      // Focus: dim everything except a node and its direct connections, and
      // reveal their names. This is how relationships stay readable at scale.
      const focus = id => {
        const near = neighbors.get(id)
        node.attr('opacity', d => near.has(d.id) ? 1 : 0.12)
        label.attr('opacity', d => near.has(d.id) ? 1 : 0)
        link
          .attr('stroke', d => (d.source.id === id || d.target.id === id) ? '#6366f1' : '#cbd5e1')
          .attr('stroke-opacity', d => (d.source.id === id || d.target.id === id) ? 0.9 : 0.06)
      }
      const clear = () => {
        node.attr('opacity', 1)
        label.attr('opacity', 0)
        link.attr('stroke', '#cbd5e1').attr('stroke-opacity', 1)
      }

      let pinned = null
      node
        .on('mouseenter', (event, d) => { if (!pinned) focus(d.id) })
        .on('mouseleave', () => { if (!pinned) clear() })
        .on('click', (event, d) => {
          event.stopPropagation()
          if (d.moved) { d.moved = false; return } // a drag, not a real click
          pinned = pinned === d.id ? null : d.id
          pinned ? focus(pinned) : clear()
        })
      svg.on('click', () => { pinned = null; clear() })

      // Zoom & pan. Node drags stop propagation (above) so they never pan.
      const zoom = d3.zoom().scaleExtent([0.1, 8])
        .on('zoom', event => layer.attr('transform', event.transform))
      svg.call(zoom)

      // Frame the whole graph once it settles, whatever its final size.
      const fitToView = () => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        nodes.forEach(d => {
          const r = radius(d)
          x0 = Math.min(x0, d.x - r); y0 = Math.min(y0, d.y - r)
          x1 = Math.max(x1, d.x + r); y1 = Math.max(y1, d.y + r)
        })
        if (!isFinite(x0)) return
        const gw = x1 - x0, gh = y1 - y0
        const scale = Math.min(8, 0.9 / Math.max(gw / width, gh / height))
        const tx = width / 2 - scale * (x0 + gw / 2)
        const ty = height / 2 - scale * (y0 + gh / 2)
        svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale))
      }
      simulation.on('end', fitToView)

      simulation.on('tick', () => {
        link
          .attr('x1', d => d.source.x)
          .attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x)
          .attr('y2', d => d.target.y)
        node.attr('transform', d => `translate(${d.x},${d.y})`)
      })
    },

    get settingsDurationValid() {
      return Number.isInteger(this.settingsDuration) && this.settingsDuration >= 1 && this.settingsDuration <= 3600
    },

    async loadSettings() {
      const res = await fetch(`/api/admin/rooms/${this.roomId}/settings`, {
        headers: { 'x-admin-token': this.token }
      })
      if (!res.ok) return
      const data = await res.json()
      this.settingsName = data.name
      // Keep the keychain label in sync with the room's real name.
      if (data.name) adminKeychain.set(this.roomId, data.name, this.token)
      this.settingsIsOpen = data.isOpen
      this.settingsScanningEnabled = data.scanningEnabled
      this.settingsQuestionsEnabled = data.questionsEnabled
      this.settingsMaxParticipants = data.maxParticipants
      this.settingsMaxParticipantsIsDefault = data.maxParticipantsIsDefault
      this.settingsDuration = data.encounterDurationSeconds
      this.settingsDurationIsDefault = data.encounterDurationIsDefault
      this.settingsTreasureHuntEnabled = data.treasureHuntEnabled
      this.settingsTreasureDefaultPoints = data.treasureDefaultPoints
      this.settingsBoardTopSize = data.boardTopSize ?? this.settingsBoardTopSize
      this.roomTtlDays = data.roomTtlDays ?? this.roomTtlDays
    },

    async renewRoom() {
      if (!confirm(`Renew this room?\n\nThis resets the auto-deletion countdown to ${this.roomTtlDays} days from now.`)) return
      const res = await fetch(`/api/admin/rooms/${this.roomId}/renew`, {
        method: 'POST',
        headers: { 'x-admin-token': this.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (res.ok) {
        const data = await res.json()
        this.expiresAt = data.expiresAt
        this.roomTtlDays = data.roomTtlDays ?? this.roomTtlDays
        this.startCountdown()
        this.showToast(`Renewed for ${this.roomTtlDays} days`)
      } else {
        this.showToast('Failed to renew room')
      }
    },

    async saveSettings() {
      const res = await fetch(`/api/admin/rooms/${this.roomId}/settings`, {
        method: 'PUT',
        headers: { 'x-admin-token': this.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: this.settingsName.trim(),
          isOpen: this.settingsIsOpen,
          scanningEnabled: this.settingsScanningEnabled,
          questionsEnabled: this.settingsQuestionsEnabled,
          maxParticipants: this.settingsMaxParticipants,
          encounterDurationSeconds: this.settingsDuration,
          treasureHuntEnabled: this.settingsTreasureHuntEnabled,
          treasureDefaultPoints: this.settingsTreasureDefaultPoints,
          boardTopSize: this.settingsBoardTopSize,
        }),
      })
      if (res.ok) {
        this.settingsDurationIsDefault = false
        this.showToast('Settings saved')
      } else {
        const err = await res.json().catch(() => ({}))
        this.showToast(err.error || 'Failed to save settings')
      }
    },

    // Pausing/resuming the game is an emergency switch — apply it immediately
    // rather than waiting for the "Save settings" button.
    async saveScanningEnabled() {
      const res = await fetch(`/api/admin/rooms/${this.roomId}/settings`, {
        method: 'PUT',
        headers: { 'x-admin-token': this.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanningEnabled: this.settingsScanningEnabled }),
      })
      if (res.ok) {
        this.showToast(this.settingsScanningEnabled ? 'Game resumed — scanning enabled' : 'Game paused — scanning blocked')
      } else {
        this.settingsScanningEnabled = !this.settingsScanningEnabled
        this.showToast('Failed to update game status')
      }
    },

    async resetMaxParticipants() {
      const res = await fetch(`/api/admin/rooms/${this.roomId}/settings`, {
        method: 'PUT',
        headers: { 'x-admin-token': this.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxParticipants: null }),
      })
      if (res.ok) {
        await this.loadSettings()
        this.showToast('Max participants reset to server default')
      } else {
        this.showToast('Failed to reset max participants')
      }
    },

    async resetDuration() {
      const res = await fetch(`/api/admin/rooms/${this.roomId}/settings`, {
        method: 'PUT',
        headers: { 'x-admin-token': this.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ encounterDurationSeconds: null }),
      })
      if (res.ok) {
        await this.loadSettings()
        this.showToast('Duration reset to server default')
      } else {
        this.showToast('Failed to reset duration')
      }
    },

    async deleteRoom() {
      if (!confirm(`Delete room "${this.settingsName || this.roomId}" and all its data? This cannot be undone.`)) return
      const res = await fetch(`/api/admin/rooms/${this.roomId}`, {
        method: 'DELETE',
        headers: { 'x-admin-token': this.token },
      })
      if (res.ok) {
        adminKeychain.remove(this.roomId)
        this.authenticated = false
        this.showToast('Room deleted')
        setTimeout(() => { window.location.href = '/admin' }, 2000)
      } else {
        this.showToast('Failed to delete room')
      }
    },

    async deleteUser(uid, name) {
      if (!confirm(`Remove ${name} from this room?`)) return
      const res = await fetch(`/api/admin/rooms/${this.roomId}/users/${uid}`, {
        method: 'DELETE',
        headers: { 'x-admin-token': this.token }
      })
      if (res.ok) {
        this.showToast(`Removed ${name}`)
        await this.loadScores()
      } else {
        this.showToast('Failed to remove user')
      }
    },

    generateRoomQr() {
      const container = document.getElementById('room-qr')
      if (!container) return
      const url = `${window.location.origin}/r/${this.roomId}`
      const qr = qrcode(0, 'M')
      qr.addData(url)
      qr.make()
      container.innerHTML = qr.createImgTag(5, 0)
    },

    // Render the room's join QR code into the hidden print area, then open the
    // browser print dialog. The @media print CSS fills the whole A4 page with it.
    printRoomQr() {
      const container = document.getElementById('room-print')
      if (!container) return
      const roomName = (this.settingsName || '').trim()
      const url = `${window.location.origin}/r/${this.roomId}`
      const qr = qrcode(0, 'M')
      qr.addData(url)
      qr.make()
      container.innerHTML = `
        <div class="room-print__card">
          ${roomName ? `<div class="room-print__name">${escapeHtml(roomName)}</div>` : ''}
          <div class="room-print__qr">${qr.createImgTag(10, 0)}</div>
        </div>`
      this.$nextTick(() => window.print())
    },

    copyUrl() {
      const url = `${window.location.origin}/r/${this.roomId}`
      navigator.clipboard.writeText(url).then(() => {
        this.copied = true
        setTimeout(() => { this.copied = false }, 2000)
      })
    },

    // ── Questions ──
    async loadQuestions() {
      const res = await fetch(`/api/admin/rooms/${this.roomId}/questions`, {
        headers: { 'x-admin-token': this.token }
      })
      if (!res.ok) return
      const data = await res.json()
      this.questions = data.questions || []
    },

    async addQuestion() {
      const text = this.newQuestionText.trim()
      if (!text) return
      const res = await fetch(`/api/admin/rooms/${this.roomId}/questions`, {
        method: 'POST',
        headers: { 'x-admin-token': this.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (res.ok) {
        this.newQuestionText = ''
        await this.loadQuestions()
      } else {
        const err = await res.json().catch(() => ({}))
        this.showToast(err.error || 'Failed to add question')
      }
    },

    async deleteQuestion(q) {
      if (!confirm(`Remove "${q.text}"?`)) return
      const res = await fetch(`/api/admin/rooms/${this.roomId}/questions/${q.id}`, {
        method: 'DELETE',
        headers: { 'x-admin-token': this.token },
      })
      if (res.ok) {
        await this.loadQuestions()
      } else {
        this.showToast('Failed to remove question')
      }
    },

    // ── Treasure hunt ──
    async loadTreasures() {
      const res = await fetch(`/api/admin/rooms/${this.roomId}/treasures`, {
        headers: { 'x-admin-token': this.token }
      })
      if (!res.ok) return
      const data = await res.json()
      this.treasures = data.treasures || []
      this.treasureDefaultPoints = data.defaultPoints ?? 3
    },

    async addTreasure() {
      const label = this.newTreasureLabel.trim()
      const points = this.newTreasurePoints === '' || this.newTreasurePoints === null
        ? null
        : Number(this.newTreasurePoints)
      const res = await fetch(`/api/admin/rooms/${this.roomId}/treasures`, {
        method: 'POST',
        headers: { 'x-admin-token': this.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, points }),
      })
      if (res.ok) {
        this.newTreasureLabel = ''
        this.newTreasurePoints = ''
        await this.loadTreasures()
      } else {
        const err = await res.json().catch(() => ({}))
        this.showToast(err.error || 'Failed to add treasure')
      }
    },

    async saveTreasure(t) {
      const points = t.points === '' || t.points === null || t.points === undefined
        ? null
        : Number(t.points)
      const res = await fetch(`/api/admin/rooms/${this.roomId}/treasures/${t.id}`, {
        method: 'PUT',
        headers: { 'x-admin-token': this.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: (t.label || '').trim(), points }),
      })
      if (res.ok) {
        await this.loadTreasures()
        this.showToast('Treasure saved')
      } else {
        const err = await res.json().catch(() => ({}))
        this.showToast(err.error || 'Failed to save treasure')
      }
    },

    async toggleTreasure(t) {
      const res = await fetch(`/api/admin/rooms/${this.roomId}/treasures/${t.id}`, {
        method: 'PUT',
        headers: { 'x-admin-token': this.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: t.enabled !== 1 }),
      })
      if (res.ok) {
        await this.loadTreasures()
      } else {
        this.showToast('Failed to update treasure')
      }
    },

    async deleteTreasure(t) {
      if (!confirm(`Delete treasure "${t.label || t.id}"? Players who already scanned it keep their points.`)) return
      const res = await fetch(`/api/admin/rooms/${this.roomId}/treasures/${t.id}`, {
        method: 'DELETE',
        headers: { 'x-admin-token': this.token },
      })
      if (res.ok) {
        await this.loadTreasures()
      } else {
        this.showToast('Failed to delete treasure')
      }
    },

    treasureUrl(t) {
      return `${window.location.origin}/r/${this.roomId}/treasure/${t.id}`
    },

    // Render the chosen treasures into the hidden print area, then open the
    // browser print dialog. The @media print CSS shows only that area.
    printTreasures(list) {
      const container = document.getElementById('treasure-print')
      if (!container) return
      const roomName = (this.settingsName || '').trim()
      container.innerHTML = list.map((t) => {
        const qr = qrcode(0, 'M')
        qr.addData(this.treasureUrl(t))
        qr.make()
        const points = (t.points ?? this.treasureDefaultPoints)
        return `
          <div class="treasure-card">
            ${roomName ? `<div class="treasure-card__room">${escapeHtml(roomName)}</div>` : ''}
            ${qr.createImgTag(6, 1)}
            <div class="treasure-card__label">${escapeHtml(t.label || 'Treasure')}</div>
            <div class="treasure-card__meta">
              room ${escapeHtml(this.roomId)} · #${escapeHtml(t.id)}
            </div>
          </div>`
      }).join('')
      this.$nextTick(() => window.print())
    },

    printTreasure(t) { this.printTreasures([t]) },
    printAllTreasures() {
      if (this.treasures.length === 0) { this.showToast('No treasures to print'); return }
      this.printTreasures(this.treasures)
    },

    showToast(msg) {
      this.toast = msg
      setTimeout(() => { this.toast = '' }, 3000)
    },

    networkTagStyle(tag) {
      if (!tag) return {}
      const hue = parseInt(tag.slice(0, 2), 16) * 360 / 256
      return {
        background: `hsl(${hue}, 55%, 82%)`,
        color: `hsl(${hue}, 40%, 28%)`,
      }
    },

    formatDate(iso) {
      if (!iso) return '—'
      const d = new Date(iso * 1000)
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    }
  }
}

// Register with Alpine (loaded from CDN) once it boots — no global needed.
document.addEventListener('alpine:init', () => Alpine.data('adminApp', adminApp))
