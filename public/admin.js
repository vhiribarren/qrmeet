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

// The admin console: a device-local launcher for every room the organiser
// administers. The keychain (storage.js) is the single source of truth; this
// page never persists anything the player session can see.
function adminHome() {
  return {
    rooms: [],
    mode: 'list',          // 'list' | 'add' | 'create'
    busy: false,
    error: '',
    toast: '',
    // Add-existing form
    addCode: '',
    addPassword: '',
    // Create form
    createName: '',
    createPassword: '',

    init() {
      this.refresh()
    },

    refresh() {
      // Most recently touched rooms are listed via keychain order; keep it simple.
      this.rooms = adminKeychain.list()
    },

    async hashPassword(password) {
      const data = new TextEncoder().encode(password)
      const buf  = await crypto.subtle.digest('SHA-256', data)
      return btoa(String.fromCharCode(...new Uint8Array(buf)))
    },

    open(roomId) {
      window.location.href = `/r/${roomId}/admin`
    },

    forget(roomId, name) {
      if (!confirm(`Remove "${name || roomId}" from this device? The room itself is not deleted; you can re-add it with its password.`)) return
      adminKeychain.remove(roomId)
      this.refresh()
      this.showToast('Removed from this device')
    },

    // Add a room the organiser already created elsewhere, by code + password.
    async addExisting() {
      this.error = ''
      const code = this.addCode.trim().toLowerCase()
      if (!code || !this.addPassword) return
      this.busy = true
      try {
        const token = await this.hashPassword(this.addPassword)
        // Authenticate against an admin endpoint; this both verifies the
        // password and confirms the room exists.
        const res = await fetch(`/api/admin/rooms/${code}/scores`, {
          headers: { 'x-admin-token': token },
        })
        if (!res.ok) {
          this.error = res.status === 401 ? 'Wrong password' : 'Room not found'
          return
        }
        const name = await this.fetchRoomName(code)
        adminKeychain.set(code, name, token)
        this.addCode = ''
        this.addPassword = ''
        this.mode = 'list'
        this.refresh()
        this.showToast('Room added')
      } catch (e) {
        this.error = 'Connection error'
      } finally {
        this.busy = false
      }
    },

    async fetchRoomName(roomId) {
      try {
        const res = await fetch(`/api/rooms/${roomId}`)
        if (!res.ok) return ''
        const data = await res.json()
        return data.name || ''
      } catch {
        return ''
      }
    },

    async createRoom() {
      this.error = ''
      if (this.createPassword.length < 4) return
      this.busy = true
      try {
        const passwordHash = await this.hashPassword(this.createPassword)
        const res = await fetch('/api/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.createName || 'QRMeet', adminPassword: passwordHash }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          this.error = data.error || 'Failed to create room'
          return
        }
        adminKeychain.set(data.id, this.createName || 'QRMeet', passwordHash)
        window.location.href = `/r/${data.id}/admin`
      } catch (e) {
        this.error = 'Connection error'
      } finally {
        this.busy = false
      }
    },

    showToast(msg) {
      this.toast = msg
      setTimeout(() => { this.toast = '' }, 3000)
    },
  }
}

document.addEventListener('alpine:init', () => Alpine.data('adminHome', adminHome))
