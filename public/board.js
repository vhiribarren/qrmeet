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

function boardApp() {
  return {
    roomId: '',
    roomName: '',
    scores: [],
    totalParticipants: 0,
    boardTopSize: 10,
    totalMeetings: 0,
    topScore: 0,
    tab: 'top10',
    copied: false,
    graphData: null,
    _ws: null,
    _wsPingTimer: null,
    expiresAt: 0,
    countdown: '',
    _countdownTimer: null,

    init() {
      const match = window.location.pathname.match(/\/r\/([^/]+)\/board/)
      if (match) this.roomId = match[1]
      this.loadScores()
      this.$nextTick(() => this.generateRoomQr())
      this.connectWs()
      this.startCountdown()
    },

    // ── Data-deletion countdown ──
    startCountdown() {
      if (this._countdownTimer) clearInterval(this._countdownTimer)
      const tick = () => { this.countdown = formatCountdown(this.expiresAt) }
      tick()
      this._countdownTimer = setInterval(tick, 1000)
    },

    connectWs() {
      if (this._ws) this._ws.close()
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${proto}//${location.host}/api/rooms/${this.roomId}/board/ws`)
      ws.addEventListener('open', () => this.startWsPing())
      ws.addEventListener('message', (e) => {
        const msg = JSON.parse(e.data)
        if (msg.type === 'board_update') {
          this.loadScores()
          if (this.tab === 'graph' && this.graphData !== null) this.loadGraph()
        }
      })
      ws.addEventListener('close', () => { this.stopWsPing(); setTimeout(() => this.connectWs(), 3000) })
      ws.addEventListener('error', () => ws.close())
      this._ws = ws
    },

    // Heartbeat: a periodic ping keeps the connection alive through edge/NAT
    // idle timeouts. The server auto-responds without waking the Durable Object,
    // so reconnect churn is avoided at no compute cost.
    startWsPing() {
      this.stopWsPing()
      this._wsPingTimer = setInterval(() => {
        if (this._ws && this._ws.readyState === 1) this._ws.send('{"type":"ping"}')
      }, 30000)
    },

    stopWsPing() {
      if (this._wsPingTimer) { clearInterval(this._wsPingTimer); this._wsPingTimer = null }
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

    copyUrl() {
      const url = `${window.location.origin}/r/${this.roomId}`
      navigator.clipboard.writeText(url).then(() => {
        this.copied = true
        setTimeout(() => { this.copied = false }, 2000)
      })
    },

    async loadScores() {
      const res = await fetch(`/api/rooms/${this.roomId}/board/scores`)
      if (!res.ok) return
      const data = await res.json()
      this.scores = data.scores || []
      this.totalParticipants = data.totalParticipants || 0
      this.boardTopSize = data.boardTopSize ?? this.boardTopSize
      this.roomName = data.roomName || ''
      this.expiresAt = data.expiresAt || 0
      this.topScore = this.scores.length > 0 ? this.scores[0].score : 0
      // Server-computed over all encounters — the leaderboard is capped at boardTopSize
      // rows, so summing the returned per-user `meetings` here would undercount.
      this.totalMeetings = data.totalMeetings || 0
    },

    // True when at least one displayed participant has treasure points — used to
    // reveal the breakdown columns only when the treasure hunt is in play.
    get hasTreasures() {
      return this.scores.some((u) => (u.treasure_points || 0) > 0)
    },

    // Top 3 fill the podium; everyone from 4th down goes in the bar list.
    get topThree() {
      return this.scores.slice(0, 3)
    },
    get rest() {
      return this.scores.slice(3)
    },

    // Bar length for a rank-list row, relative to the leader's score.
    // Clamped to a visible minimum so even low scores show a sliver.
    barWidth(score) {
      if (this.topScore <= 0) return 0
      return Math.max(6, Math.round((score / this.topScore) * 100))
    },

    async loadGraph() {
      const res = await fetch(`/api/rooms/${this.roomId}/board/graph`)
      if (!res.ok) return
      this.graphData = await res.json()
      this.$nextTick(() => this.renderGraph())
    },

    renderGraph() {
      const container = document.getElementById('board-graph')
      if (!container || !this.graphData) return
      container.innerHTML = ''

      const width = container.clientWidth
      const height = container.clientHeight || 400

      const svg = d3.select(container).append('svg')
        .attr('viewBox', `0 0 ${width} ${height}`)

      const nodes = this.graphData.nodes.map(n => ({ id: n.public_id, label: n.emoji + ' ' + n.display_name, emoji: n.emoji }))
      const links = this.graphData.edges.map(e => ({ source: e.user_a_id, target: e.user_b_id }))

      const simulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links).id(d => d.id).distance(80))
        .force('charge', d3.forceManyBody().strength(-200))
        .force('x', d3.forceX(width / 2).strength(0.05))
        .force('y', d3.forceY(height / 2).strength(0.05))
        .force('collide', d3.forceCollide(28))

      const link = svg.append('g')
        .selectAll('line')
        .data(links)
        .join('line')
        .attr('stroke', '#e5e7eb')
        .attr('stroke-width', 2)

      const node = svg.append('g')
        .selectAll('g')
        .data(nodes)
        .join('g')
        .call(d3.drag()
          .on('start', (event, d) => { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
          .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
          .on('end', (event, d) => { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
        )

      node.append('circle')
        .attr('r', 20)
        .attr('fill', '#eef2ff')
        .attr('stroke', '#6366f1')
        .attr('stroke-width', 2)

      node.append('text')
        .text(d => d.emoji)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .attr('font-size', '16px')

      const r = 22
      simulation.on('tick', () => {
        link
          .attr('x1', d => d.source.x)
          .attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x)
          .attr('y2', d => d.target.y)
        node.attr('transform', d => {
          d.x = Math.max(r, Math.min(width - r, d.x))
          d.y = Math.max(r, Math.min(height - r, d.y))
          return `translate(${d.x},${d.y})`
        })
      })
    }
  }
}

// Register with Alpine (loaded from CDN) once it boots — no global needed.
document.addEventListener('alpine:init', () => Alpine.data('boardApp', boardApp))
