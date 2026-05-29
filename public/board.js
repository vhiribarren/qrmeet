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

function boardApp() {
  return {
    roomId: '',
    roomName: '',
    scores: [],
    totalParticipants: 0,
    totalMeetings: 0,
    topScore: 0,
    tab: 'top10',
    copied: false,
    graphData: null,
    _ws: null,

    init() {
      const match = window.location.pathname.match(/\/r\/([^/]+)\/board/)
      if (match) this.roomId = match[1]
      this.loadScores()
      this.$nextTick(() => this.generateRoomQr())
      this.connectWs()
    },

    connectWs() {
      if (this._ws) this._ws.close()
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${proto}//${location.host}/api/rooms/${this.roomId}/board/ws`)
      ws.addEventListener('message', (e) => {
        const msg = JSON.parse(e.data)
        if (msg.type === 'board_update') {
          this.loadScores()
          if (this.tab === 'graph' && this.graphData !== null) this.loadGraph()
        }
      })
      ws.addEventListener('close', () => { setTimeout(() => this.connectWs(), 3000) })
      ws.addEventListener('error', () => ws.close())
      this._ws = ws
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
      this.roomName = data.roomName || ''
      this.topScore = this.scores.length > 0 ? this.scores[0].score : 0
      this.totalMeetings = this.scores.reduce((sum, u) => sum + (u.score || 0), 0) / 2
      this.totalMeetings = Math.floor(this.totalMeetings)
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
