import "phoenix_html"

import { Socket } from "phoenix"
import { LiveSocket } from "phoenix_live_view"
import topbar from "../vendor/topbar"

// Show progress bar on live navigation and form submits
topbar.config({ barColors: { 0: "#29d" }, shadowColor: "rgba(0, 0, 0, .3)" })

let topBarScheduled = undefined
window.addEventListener("phx:page-loading-start", () => {
  if (!topBarScheduled) {
    topBarScheduled = setTimeout(() => topbar.show(), 120)
  }
})

window.addEventListener("phx:page-loading-stop", () => {
  clearTimeout(topBarScheduled)
  topBarScheduled = undefined
  topbar.hide()
})

let csrfToken = document.querySelector("meta[name='csrf-token']").getAttribute("content")

const hooks = {
  search: {
    mounted() {
      this.el.addEventListener("input", () => {
        console.log(this.el.value)
        this.pushEvent("search", { "q": this.el.value })
      })
    }
  },
  window: {
    dragging: false,
    x: 0,
    y: 0,
    move(x, y) {
      const rect = this.el.getBoundingClientRect()
      const outer_rect = this.el.parentElement.getBoundingClientRect()

      let width = outer_rect.width
      let height = outer_rect.height
      const max_x = Math.floor(width - rect.width)
      const max_y = Math.floor(height - rect.height)
      x = Math.min(Math.max(x, 0), max_x)
      y = Math.min(Math.max(y, 0), max_y)

      this.el.style.left = `${x}px`
      this.el.style.top = `${y}px`
    },
    mounted() {
      {
        const rect = this.el.getBoundingClientRect()
        const outer_rect = this.el.parentElement.getBoundingClientRect()
        this.move(outer_rect.width / 2 - rect.width / 2, outer_rect.height / 2 - rect.height / 2)
      }

      this.dragstart = e => {
        if (!e.target.classList.contains("header")) return

        const rect = this.el.getBoundingClientRect()

        this.dragging = true
        this.x = e.clientX - rect.left
        this.y = e.clientY - rect.top
      }

      this.dragmove = e => {
        if (!this.dragging) return

        const rect = this.el.getBoundingClientRect()

        let x = this.el.offsetLeft + e.clientX - rect.left - this.x
        let y = this.el.offsetTop + e.clientY - rect.top - this.y
        this.move(x, y)
      }

      this.dragend = e => {
        if (!this.dragging) return

        this.dragging = false

        const rect = this.el.getBoundingClientRect()

        let x = this.el.offsetLeft + e.clientX - rect.left - this.x
        let y = this.el.offsetTop + e.clientY - rect.top - this.y
        this.move(x, y)
      }

      this.el.addEventListener("mousedown", this.dragstart)
      document.addEventListener("mousemove", this.dragmove)
      document.addEventListener("mouseup", this.dragend)
    },
    destroyed() {
      console.log("unmount")
      document.removeEventListener("mousemove", this.dragmove)
      document.removeEventListener("mouseup", this.dragend)
    }
  }
}

let liveSocket = new LiveSocket("/live", Socket, { hooks: hooks, params: { _csrf_token: csrfToken } })

// connect if there are any LiveViews on the page
liveSocket.connect()

window.liveSocket = liveSocket
