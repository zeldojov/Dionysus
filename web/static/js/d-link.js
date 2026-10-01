class DLinkElement extends HTMLElement {
    connectedCallback() {
        this.contentEditable = "true";
        this.addEventListener("click", this.handleClick);
    }

    disconnectedCallback() {
        this.removeEventListener("click", this.handleClick);
    }

    handleClick(event) {
        const href = this.getAttribute("href");
        if (!href) {
            event.preventDefault();
            return;
        }

        if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            if (event.shiftKey) {
                window.open(href, "_blank", "noopener");
            } else {
                window.location.assign(href);
            }
            return;
        }

        event.preventDefault();
        window.location.assign(href);
    }
}

customElements.define("d-link", DLinkElement);
