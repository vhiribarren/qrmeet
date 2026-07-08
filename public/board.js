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
    _graphReloadTimer: null,
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
          if (this.tab === 'graph' && this.graphData !== null) this.scheduleGraphReload()
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

    // Coalesce bursts of board updates into a single graph reload so the view
    // isn't rebuilt (and the camera disturbed) on every incoming encounter.
    scheduleGraphReload() {
      clearTimeout(this._graphReloadTimer)
      this._graphReloadTimer = setTimeout(() => this.loadGraph(), 1500)
    },

    renderGraph() {
      const container = document.getElementById('board-graph')
      if (!container || !this.graphData) return
      container.innerHTML = ''

      const width = container.clientWidth
      const height = container.clientHeight || 400

      const svg = d3.select(container).append('svg')
        .attr('viewBox', `0 0 ${width} ${height}`)
      // Everything lives inside this layer so zoom/pan is a single transform.
      const layer = svg.append('g')

      // Reuse the previous layout so live updates don't reset the view: seed
      // each node with its last position and keep the camera where the user
      // left it. Only a first render (no saved layout) auto-frames the graph.
      const prev = new Map((this._graphNodes || []).map(d => [d.id, d]))
      const hadLayout = prev.size > 0
      const nodes = this.graphData.nodes.map(n => {
        const p = prev.get(n.public_id)
        return { id: n.public_id, emoji: n.emoji, x: p && p.x, y: p && p.y }
      })
      this._graphNodes = nodes
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
      // graphs stable and fast. With a saved layout we start from a low alpha so
      // a live update barely nudges the nodes instead of reshuffling them.
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
        .alpha(hadLayout ? 0.2 : 1)

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

      // Focus: dim everything except a node and its direct connections, and
      // light up their edges. This is how relationships stay readable at scale.
      const focus = id => {
        const near = neighbors.get(id)
        node.attr('opacity', d => near.has(d.id) ? 1 : 0.12)
        link
          .attr('stroke', d => (d.source.id === id || d.target.id === id) ? '#6366f1' : '#cbd5e1')
          .attr('stroke-opacity', d => (d.source.id === id || d.target.id === id) ? 0.9 : 0.06)
      }
      const clear = () => {
        node.attr('opacity', 1)
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

      // Zoom & pan. Node drags stop propagation (above) so they never pan. The
      // current transform is remembered so live re-renders keep the same camera.
      const zoom = d3.zoom().scaleExtent([0.1, 8])
        .on('zoom', event => { layer.attr('transform', event.transform); this._graphTransform = event.transform })
      svg.call(zoom)
      if (this._graphTransform) svg.call(zoom.transform, this._graphTransform)

      // Only the first render frames the graph; later ones keep the user's view.
      if (!this._graphTransform) {
        simulation.on('end', () => {
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
        })
      }

      simulation.on('tick', () => {
        link
          .attr('x1', d => d.source.x)
          .attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x)
          .attr('y2', d => d.target.y)
        node.attr('transform', d => `translate(${d.x},${d.y})`)
      })
    }
  }
}

// Register with Alpine (loaded from CDN) once it boots — no global needed.
document.addEventListener('alpine:init', () => Alpine.data('boardApp', boardApp))
