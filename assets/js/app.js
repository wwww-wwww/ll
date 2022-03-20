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
  }
}

let liveSocket = new LiveSocket("/live", Socket, { hooks: hooks, params: { _csrf_token: csrfToken } })

// connect if there are any LiveViews on the page
liveSocket.connect()

window.liveSocket = liveSocket
