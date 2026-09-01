import { ViewHook } from "phoenix_live_view"
import { Viewer } from "./viewer"

class Reader extends ViewHook {
    viewer!: Viewer

    /**
     * The chapter's image URLs.
     *
     * Just the URLs now: creating an `<img>` per page here and setting `src` on all of them is
     * what made opening a chapter start every download at once. The viewer owns loading, and only
     * fetches inside its preload window.
     */
    private files: string[] = []

    /** Continuous (webtoon) reading - scrolls rather than turns. */
    private continuous = false

    async init(continuous: boolean = false) {
        this.viewer = await Viewer.new(continuous)
        this.el.appendChild(this.viewer)

        // Mihon routes a tap through `config.navigator.getAction`, which splits the screen into
        // menu / next / prev regions. This is the same idea with yuriyomi's own bindings: the
        // outer thirds turn the page (right-to-left, so the left edge advances), the middle keeps
        // the existing toggle.
        //
        // Continuous reading scrolls instead of turning - `WebGpuViewerContinuous` overrides
        // moveRight/moveLeft to half a viewport, and jumping a whole page on a tap would skip
        // past most of a webtoon strip.
        this.viewer.onTap = x => {
            if (x >= 0.33 && x <= 0.67) {
                document.getElementById("series_details_toggle")?.click()
            } else if (this.continuous) {
                if (x < 0.33) this.viewer.moveLeft()
                else this.viewer.moveRight()
            } else {
                this.turn(x < 0.33 ? 1 : -1)
            }
        }

        // The old viewer went fullscreen on a one-second hold; the gesture layer reports the hold
        // as a long tap instead of hard-coding what it does.
        this.viewer.onLongTap = () => {
            if (!document.fullscreenElement) this.viewer.requestFullscreen().catch(() => { })
            else document.exitFullscreen().catch(() => { })
        }

        // Fires for a swipe, a tap-to-turn and a programmatic move alike, so guard against the
        // re-entrant case: set_page below moves the viewer, which reports the move straight back.
        let notified = -1
        this.viewer.onPageChange = page => {
            if (page === notified) return
            notified = page
            this.set_page(page)
            notified = -1
        }
    }

    private e_page!: HTMLElement
    private e_interstitial!: HTMLElement

    private next_chapter!: HTMLElement | null
    private prev_chapter!: HTMLElement | null
    private navigating = false

    set_page(page: number, push_state: boolean = true) {
        Array.from(document.getElementsByClassName("order-page")).forEach(e => {
            e.classList.toggle("selected", e.getAttribute("index") == page.toString())
            if (e.getAttribute("index") == page.toString()) {
                e.scrollIntoView({ block: "nearest" })
            }
        })
        if (this.files.length == 0) return

        if (page == this.files.length || page == -1) {
            let next_chapter: HTMLElement | null = null

            next_chapter = page == this.files.length ? this.next_chapter : this.prev_chapter

            if (!next_chapter) return

            if (this.e_interstitial.classList.contains("visible")) {
                this.navigating = true
                next_chapter.querySelector("a")?.click()
                this.e_interstitial.classList.toggle("visible", false)
                return
            }

            this.e_interstitial.textContent = next_chapter.querySelector(".title")!.textContent
            this.e_interstitial.classList.toggle("visible", true)
            return
        }

        if (this.e_interstitial.classList.contains("visible")) {
            this.e_interstitial.classList.toggle("visible", false)
            return
        }

        if (push_state) {
            const params = new URLSearchParams(window.location.search)
            params.set("page", (page + 1).toString())
            const new_url = decodeURIComponent(`${window.location.pathname}?${params}`)
            window.history.replaceState({ ...window.history.state, page: page }, "", new_url)
        }

        this.viewer.set_page(Math.max(Math.min(page, this.files.length - 1), 0))
        this.e_page.textContent = `${this.viewer.page + 1}/${this.files.length}`
        this.viewer.invalidate()
    }

    /**
     * Turn one page in [direction], or fall off the end into the chapter interstitial.
     *
     * The viewer steps by page, so a spread's two halves count as one - which is what the old
     * hand-rolled "is the next file the same page?" check here was for.
     */
    private turn(direction: number) {
        const next = this.viewer.stepFileIndex(direction)
        if (next !== null) this.set_page(next)
        else this.set_page(direction > 0 ? this.files.length : -1)
    }

    private key_event!: ((e: KeyboardEvent) => void) | null

    get_storage(name: string): string | null {
        return window.localStorage.getItem(`${this.constructor.name}-${name}`)
    }

    set_storage(name: string, value: string | number) {
        window.localStorage.setItem(`${this.constructor.name}-${name}`, value.toString())
    }

    /**
     * Wire one checkbox in `#reader-settings` to a viewer setting, remembered across reloads.
     *
     * Storage wins, then [fallback] - and the box is set from that answer rather than read for it,
     * since the panel is `phx-update="ignore"` and a browser may restore whatever was ticked last.
     * Missing markup is not an error: the panel is not on every page this hook runs on.
     */
    private bindSetting(id: string, apply: (on: boolean) => void, fallback: boolean) {
        const box = document.getElementById(id) as HTMLInputElement | null
        if (!box) return

        const saved = this.get_storage(id)
        const on = saved === null ? fallback : saved === "true"
        box.checked = on
        apply(on)

        const listener = () => {
            this.set_storage(id, box.checked.toString())
            apply(box.checked)
        }
        box.addEventListener("change", listener)
        // The panel outlives this hook, so [destroyed] takes the listener off - left on, a
        // re-mounted hook would stack another pointing at a dead viewer.
        this.unbind.push(() => box.removeEventListener("change", listener))
    }

    private readonly unbind: (() => void)[] = []

    mounted() {
        this.e_page = this.el.querySelector(".info>.page")!
        this.e_interstitial = this.el.querySelector(".interstitial")!

        this.e_interstitial.onclick = e => {
            const rect = this.e_interstitial.getBoundingClientRect()
            const x = (e.clientX - rect.x) / rect.width
            this.turn(x < 0.5 ? 1 : -1)
        }

        let mounted = false

        let chapters: HTMLElement[] | null = null

        if (document.getElementById("chapterlist")) {
            chapters = Array.from(document.getElementById("chapterlist")!.children) as HTMLElement[]
            const current_index = chapters.findIndex(e => e.classList.contains("selected"))
            this.next_chapter = current_index > 0 ? chapters.at(current_index - 1)! : null
            this.prev_chapter = chapters.at(current_index + 1)!
        }

        const data = JSON.parse(this.el.dataset.files! || "{}")

        const reading_mode = this.el.dataset.readingMode

        this.files = data.files ?? []

        this.handleEvent("move", data => {
            this.set_page(data.index)
        })

        this.handleEvent("files", data => {
            if (!mounted) return
            console.info("files", data, window.history.state)

            this.files = data.files ?? []

            this.e_interstitial.classList.toggle("visible", false)

            let start = window.history.state.page || 0

            if (chapters) {
                const current_index = chapters.findIndex(e => e.classList.contains("selected"))

                if (this.navigating && this.prev_chapter == chapters.at(current_index)) {
                    start = this.files.length - 1
                }

                this.next_chapter = current_index > 0 ? chapters.at(current_index - 1)! : null
                this.prev_chapter = chapters.at(current_index + 1)!
            }

            // One call: the viewer needs the list and the starting position together, so it can
            // open its preload window at the right place rather than at page 0 first.
            this.viewer.setPages(this.files, data.order ?? null, start)
            this.set_page(this.viewer.page, false)

            this.navigating = false
        })

        const params = new URLSearchParams(window.location.search)
        const page = window.history.state.page || parseInt(params?.get("page")! ?? "1") - 1

        // Continuous (webtoon) reading stacks the pages and scrolls them as one document. Decided
        // before the viewer is built: the mode picks a different state object, and its frame loop
        // starts on connect.
        const continuous = reading_mode === "continuous"
        this.continuous = continuous

        this.init(continuous).then(() => {
            this.bindSetting("chk_3dlut", on => (this.viewer.colorManagement = on), true)

            // Right-to-left, as the arrow-key bindings below have always assumed - but a
            // continuous viewer scrolls top-to-bottom, and reversing it would send the arrow keys
            // and the tap regions the wrong way.
            this.viewer.configure({ reversed: !continuous })
            this.viewer.setPages(this.files, data.order ?? null, page)
            this.set_page(this.viewer.page)
            mounted = true
        })

        this.key_event = (e: KeyboardEvent) => {
            if (
                document.activeElement?.tagName == "INPUT" ||
                document.activeElement?.tagName == "TEXTAREA"
            ) {
                return
            }

            // Continuous scrolls on the vertical axis it actually reads along; the horizontal
            // arrows keep turning pages so a jump is still reachable.
            if (this.continuous && (e.key == "ArrowDown" || e.key == "ArrowUp")) {
                e.preventDefault()
                if (e.key == "ArrowDown") this.viewer.moveRight()
                else this.viewer.moveLeft()
                return
            }

            if (e.key == "ArrowLeft") {
                e.preventDefault()
                this.turn(1)
            }
            if (e.key == "ArrowRight") {
                e.preventDefault()
                this.turn(-1)
            }
        }

        window.addEventListener("keydown", this.key_event)
    }

    destroyed() {
        window.removeEventListener("keydown", this.key_event!)
        this.unbind.forEach(off => off())
        this.unbind.length = 0
    }
}

class chapterlist extends ViewHook {
    mounted() {
        Array.from(this.el.children).forEach(e => {
            if (e.classList.contains("selected")) {
                e.scrollIntoView({ block: "center" })
            }
        })
    }
}

export default { Reader, chapterlist }
