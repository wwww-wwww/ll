import { ViewHook } from "phoenix_live_view"
export default class Library extends ViewHook {
    input: HTMLInputElement | null = null
    onInput = () => this.filter()

    onKey = (e: KeyboardEvent) => {
        const t = e.target as HTMLElement
        if (e.key === "Escape" && t === this.input) {
            this.input.value = ""
            this.filter()
            return
        }
        if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return
        if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
        e.preventDefault()
        this.input?.focus()
    }

    mounted() {
        this.input = document.getElementById("library_search") as HTMLInputElement | null
        this.input?.addEventListener("input", this.onInput)
        window.addEventListener("keydown", this.onKey)
        this.filter()
    }

    updated() { this.filter() }

    destroyed() {
        this.input?.removeEventListener("input", this.onInput)
        window.removeEventListener("keydown", this.onKey)
    }

    filter() {
        const q = (this.input?.value ?? "").trim().toLowerCase()
        this.el.querySelectorAll<HTMLElement>(".SeriesComponent").forEach(card => {
            const title = card.querySelector(".title")?.textContent?.toLowerCase() ?? ""
            const aliases = card.dataset.search?.toLowerCase() ?? ""
            card.style.display = title.includes(q) || aliases.includes(q) ? "" : "none"
        })
    }
}
