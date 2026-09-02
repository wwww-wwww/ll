import { ViewHook } from "phoenix_live_view"
import { Viewer } from "./viewer"

/** A chapter's pages, as the reader can work them out for itself - see `Reader.openWindow`. */
interface ChapterPages {
    files: string[]
    /**
     * Which half of a spread each page is.
     *
     * Never null, unlike the server's own: a chapter with no detected order gets all 2s, which is
     * the "single page" the viewer reads it as anyway.
     */
    order: number[]
}

/**
 * [chapter]'s pages from its entry in the chapter list, or null where it has none to give.
 *
 * `data-pages` is only rendered for a chapter whose files are all downloaded, so its absence is the
 * same answer as the entry's dead link: not readable yet.
 */
function chapterPages(chapter: HTMLElement): ChapterPages | null {
    const id = chapter.dataset.chapterId
    const count = Number(chapter.dataset.pages)
    if (!id || !Number.isInteger(count) || count <= 0) return null

    const files: string[] = []
    for (let i = 1; i <= count; i++) files.push(`/page/${id}/${i}`)

    let order: number[] | null = null
    if (chapter.dataset.order) {
        try {
            const parsed = JSON.parse(chapter.dataset.order)
            if (Array.isArray(parsed) && parsed.length === count) order = parsed
        } catch (e) {
            console.warn("chapter order", chapter.dataset.order, e)
        }
    }
    return { files, order: order ?? new Array(count).fill(2) }
}

/** One chapter's stretch of the viewer's page list - see `Reader.chapterWindow`. */
interface WindowChapter {
    /** Its position in the chapter list, which runs newest first. -1 for a chapter not in it. */
    at: number
    /** First file index of this chapter within the viewer's list, and how many files it has. */
    start: number
    count: number
}

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

        // Reports where the viewer went, and nothing here moves it in response - so a swipe, a
        // tap-to-turn and a programmatic move can all come through the one path.
        this.viewer.onPageChange = page => this.pageChanged(page)
    }

    private e_page!: HTMLElement

    /**
     * The chapters the viewer's page list holds, in reading order.
     *
     * A chapter boundary is a page boundary like any other, which only works if both chapters are
     * already in the list - so the neighbours load alongside the chapter being read, and the list
     * is extended rather than rebuilt as the reader moves through them. [Viewer.setPages] drops
     * every decoded page, and doing that under a turn is the seam this avoids.
     */
    private chapterWindow: WindowChapter[] = []

    /** Which of [chapterWindow] is being read - the one the URL, title and counter follow. */
    private reading: WindowChapter | null = null

    /**
     * Patches this hook asked for that are still in flight, so the files events they bring can be
     * ignored: those chapters are in the list already, with the order that came alongside them.
     *
     * A count rather than a flag - crossing two boundaries in quick succession leaves two.
     */
    private ownPatches = 0

    /**
     * Go to [page] of the chapter being read, counted from 0 - the numbering everything outside
     * this hook uses, the URL and the order table included.
     */
    set_page(page: number, push_state: boolean = true) {
        const chapter = this.reading
        if (!chapter) return
        const at = Math.max(Math.min(page, chapter.count - 1), 0)
        this.viewer.set_page(chapter.start + at)
        this.showPage(at, push_state)
        this.viewer.invalidate()
    }

    /**
     * Reflect [page] of the chapter being read in the URL, the counter and the order table.
     *
     * Apart from [set_page] because the viewer is as likely to be reporting where it went as being
     * told where to go - see [pageChanged].
     */
    private showPage(page: number, push_state: boolean = true) {
        Array.from(document.getElementsByClassName("order-page")).forEach(e => {
            e.classList.toggle("selected", e.getAttribute("index") == page.toString())
            if (e.getAttribute("index") == page.toString()) {
                e.scrollIntoView({ block: "nearest" })
            }
        })

        const chapter = this.reading
        if (!chapter) return

        if (push_state) {
            const params = new URLSearchParams(window.location.search)
            params.set("page", (page + 1).toString())
            const new_url = decodeURIComponent(`${window.location.pathname}?${params}`)
            window.history.replaceState({ ...window.history.state, page: page }, "", new_url)
        }

        this.e_page.textContent = `${page + 1}/${chapter.count}`
    }

    /**
     * The viewer is showing file [index] of its list - which chapter that falls in decides the
     * rest.
     *
     * Where a chapter change is noticed, rather than anywhere that could refuse one: crossing is a
     * page turn, so by the time this runs the new chapter is already on screen.
     */
    private pageChanged(index: number) {
        const chapter = this.chapterWindow.find(c => index >= c.start && index < c.start + c.count)
        if (!chapter) return

        if (chapter !== this.reading) {
            const forward = this.reading !== null && chapter.at < this.reading.at
            this.reading = chapter
            // Posted, not run here. This fires from inside the turn that crossed the boundary,
            // before it has set its animation up - and following the reader means a patch and a
            // change to the page list, either of which lands in the middle of that. The viewer
            // posts its own tail out of this callback for the same reason.
            queueMicrotask(() => this.enterChapter(chapter, forward))
        }

        this.showPage(index - chapter.start)
    }

    /**
     * Follow the reader into [chapter]: the URL, the title and the order table belong to whichever
     * chapter is being read, and only a patch moves them.
     *
     * Extends the window past it at the same time, so its far boundary is another page turn rather
     * than a stop. [forward] is which way the reader crossed, since by the time this runs
     * [reading] is already the chapter it arrived in.
     */
    private enterChapter(chapter: WindowChapter, forward: boolean) {
        // Left behind by a jump that landed elsewhere before this ran.
        if (chapter !== this.reading) return

        const link = this.chapterAt(chapter.at)?.querySelector("a")
        if (link) {
            this.ownPatches++
            link.click()
        }

        this.extend(forward ? 1 : -1)
    }

    /** The chapter list's entry at [at], or null past either end of it. */
    private chapterAt(at: number): HTMLElement | null {
        const list = document.getElementById("chapterlist")
        if (!list || at < 0) return null
        return (list.children.item(at) as HTMLElement | null) ?? null
    }

    /** Where the chapter being read sits in the list, or null when it is not in it at all. */
    private selectedChapter(): number | null {
        const list = document.getElementById("chapterlist")
        if (!list) return null
        const at = Array.from(list.children).findIndex(e => e.classList.contains("selected"))
        return at < 0 ? null : at
    }

    /**
     * Load one more chapter onto the [direction] end of the window - forward is +1.
     *
     * The list runs newest first, so reading forward walks it backwards. Appending disturbs no
     * index the viewer has handed out; prepending shifts them, which [Viewer.prependPages] does
     * without losing a decode.
     *
     * One chapter per call, which is also what keeps its spreads its own - see [openWindow].
     */
    private extend(direction: number) {
        const edge =
            direction > 0 ?
                this.chapterWindow[this.chapterWindow.length - 1]
            :   this.chapterWindow[0]
        if (!edge || edge.at < 0) return

        const at = edge.at - direction
        if (this.chapterWindow.some(c => c.at === at)) return

        const element = this.chapterAt(at)
        const pages = element && chapterPages(element)
        if (!pages) return

        if (direction > 0) {
            this.viewer.appendPages(pages.files, pages.order)
            this.chapterWindow.push({
                at: at,
                start: edge.start + edge.count,
                count: pages.files.length,
            })
            this.files = [...this.files, ...pages.files]
        } else {
            this.viewer.prependPages(pages.files, pages.order)
            for (const c of this.chapterWindow) c.start += pages.files.length
            this.chapterWindow.unshift({ at: at, start: 0, count: pages.files.length })
            this.files = [...pages.files, ...this.files]
        }
    }

    /**
     * Build the window around the chapter at [at] and open it at [page].
     *
     * A load, or a jump from the chapter list to somewhere the window does not reach - the only
     * points where dropping what is decoded costs nothing. Both neighbours follow through
     * [extend], since a turn has to find them already there.
     *
     * One chapter per call into the viewer, never a concatenated list: pairing happens within a
     * call, so a spread can never take the last page of one chapter and the first of the next.
     */
    private openWindow(at: number, page: number, order: number[] | null) {
        const element = this.chapterAt(at)
        const pages = element && chapterPages(element)
        if (!pages) return

        // The chapter being read takes the server's order over the list's: an order just saved
        // reaches this hook that way before the list catches up.
        const own =
            order !== null && order.length === pages.files.length ? order : pages.order

        // The viewer needs the list and the starting position together, so it can open its preload
        // window at the right place rather than at page 0 first.
        this.viewer.setPages(pages.files, own, page)
        this.chapterWindow = [{ at: at, start: 0, count: pages.files.length }]
        this.reading = this.chapterWindow[0]
        this.files = [...pages.files]

        // Reading order: the list runs newest first, so forward is the entry before this one.
        this.extend(1)
        this.extend(-1)

        this.showPage(page, false)
    }

    /**
     * One chapter on its own, from the server's own file list - for a chapter the list does not
     * show, a hidden one above all. Nothing to turn onto, since there is no entry to read a
     * neighbour from.
     */
    private openSingle(files: string[], order: number[] | null, page: number) {
        this.chapterWindow = [{ at: -1, start: 0, count: files.length }]
        this.reading = this.chapterWindow[0]
        this.files = files
        this.viewer.setPages(files, order, page)
        this.showPage(page, false)
    }

    /**
     * Turn one page in [direction], across a chapter boundary like any other.
     *
     * The viewer steps by page, so a spread's two halves count as one - which is what the old
     * hand-rolled "is the next file the same page?" check here was for. Only the far edge of the
     * window stops it, and then only until the chapter past it is pulled in.
     */
    private turn(direction: number) {
        let next = this.viewer.stepFileIndex(direction)
        if (next === null) {
            this.extend(direction)
            next = this.viewer.stepFileIndex(direction)
        }
        if (next === null) return
        // set_page reports the move through onPageChange, which is where the chapter it lands in
        // is worked out - nothing more to do here.
        this.viewer.set_page(next)
        this.viewer.invalidate()
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

        let mounted = false

        const data = JSON.parse(this.el.dataset.files! || "{}")

        const reading_mode = this.el.dataset.readingMode

        this.files = data.files ?? []

        this.handleEvent("move", data => {
            this.set_page(data.index)
        })

        this.handleEvent("files", data => {
            if (!mounted) return

            // The patch behind a boundary turn: that chapter is in the list already, read past by
            // now, and rebuilding for it would drop every page decoded on the way in.
            if (this.ownPatches > 0) {
                this.ownPatches--
                return
            }

            const at = this.selectedChapter()
            const page = window.history.state?.page ?? 0
            if (at === null) this.openSingle(data.files ?? [], data.order ?? null, page)
            else this.openWindow(at, page, data.order ?? null)
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
            const at = this.selectedChapter()
            if (at === null) this.openSingle(this.files, data.order ?? null, page)
            else this.openWindow(at, page, data.order ?? null)
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
