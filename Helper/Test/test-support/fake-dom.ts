// A tiny stand-in for the browser DOM, for unit tests that run in Node.
//
// Why not jsdom: it would be a new dependency, and our UI code only ever uses
// a handful of DOM calls on purpose (createElement, setAttribute,
// removeAttribute, textContent, append, replaceChildren; see Source/web-page/safe-dom.ts).
// This fake implements exactly those and RECORDS them, so a test can also
// prove that nothing else (such as innerHTML) was used: any other property
// set on a fake element throws.
// Source/web-page/review.ts also uses insertBefore (its box goes right after an
// email's heading).
// For the interactive parts (Source/web-page/add-files.ts, Source/web-page/preview.ts) it also
// has event listeners (addEventListener + a test-side `fire`), click(),
// focus() (counted, its options kept), getBoundingClientRect() (from a
// test-set `rect`), scrollIntoView() (recorded), contains(), the `value` / `files` fields of a file input or select, and a
// checkbox's `checked`. FakeEventTarget stands in for `window` (page-wide
// drag-and-drop listeners). FakeDocument has a `body`, an `activeElement`
// and event listeners ('focusin', 'pointerdown'), and FakeElement an
// `isConnected`, which a test sets itself (Source/web-page/mount-page.ts checks whether the
// focused control was removed).
// The real page is checked in a real browser by the e2e tests.

export class FakeText
{
    readonly nodeType = 3;
    constructor(readonly data: string)
    {
    }
}

export type FakeNode = FakeElement | FakeText;

/** A test event: any plain object; `fire` adds `type`, `target` and preventDefault(). */
export interface FakeEvent
{
    type: string;
    target: unknown;
    defaultPrevented: boolean;
    preventDefault(): void;
    [key: string]: unknown;
}

type FakeListener = (event: FakeEvent) => void;

/** Listeners by event type, shared by FakeElement and FakeEventTarget. */
class Listeners
{
    private readonly byType = new Map<string, FakeListener[]>();

    add(type: string, listener: FakeListener): void
    {
        this.byType.set(type, [...(this.byType.get(type) ?? []), listener]);
    }

    remove(type: string, listener: FakeListener): void
    {
        this.byType.set(
            type,
            (this.byType.get(type) ?? []).filter((l) => l !== listener),
        );
    }

    count(type: string): number
    {
        return this.byType.get(type)?.length ?? 0;
    }

    /** Calls every listener of `type` with a FakeEvent built from `init`; returns the event. */
    fire(type: string, target: unknown, init: Record<string, unknown>): FakeEvent
    {
        const event: FakeEvent = {
            target,
            ...init,
            type,
            defaultPrevented: false,
            preventDefault()
            {
                event.defaultPrevented = true;
            },
        };
        for (const listener of this.byType.get(type) ?? [])
        {
            listener(event);
        }
        return event;
    }
}

/** Stands in for `window`: only event listeners. */
export class FakeEventTarget
{
    readonly listeners = new Listeners();

    addEventListener(type: string, listener: FakeListener): void
    {
        this.listeners.add(type, listener);
    }

    removeEventListener(type: string, listener: FakeListener): void
    {
        this.listeners.remove(type, listener);
    }

    /** Test side: dispatches an event to this target's listeners (target defaults to this). */
    fire(type: string, init: Record<string, unknown> = {}): FakeEvent
    {
        return this.listeners.fire(type, this, init);
    }
}

export class FakeElement
{
    readonly nodeType = 1;
    readonly attributes = new Map<string, string>();
    children: FakeNode[] = [];
    /** A file input's value (code may only clear it) and chosen files. */
    value = '';
    files: unknown = null;
    /** A checkbox's state (the user ticks it in a test by setting it, then firing 'change'). */
    checked = false;
    /** How many times click() was called. */
    clicks = 0;
    /** How many times focus() was called. */
    focuses = 0;
    /** Set by a test (the fake has no real tree): false stands for "removed from the page". */
    isConnected = true;
    readonly listeners = new Listeners();
    // Text set with textContent (a plain field: a #private field would not work
    // through the Proxy below).
    private ownText = '';

    constructor(readonly tagName: string)
    {
        // Freeze the shape: setting any property this fake does not know about
        // (innerHTML, outerHTML, onclick, ...) throws instead of passing silently.
        return new Proxy(this, {
            set(target, property, value, receiver)
            {
                if (typeof property === 'string' && !(property in target))
                {
                    throw new Error(`fake DOM: setting "${property}" is not allowed`);
                }
                return Reflect.set(target, property, value, receiver);
            },
        });
    }

    get textContent(): string
    {
        return this.ownText + this.children.map((c) => (c instanceof FakeText ? c.data : c.textContent)).join('');
    }

    set textContent(value: string)
    {
        this.children = [];
        this.ownText = value;
    }

    setAttribute(name: string, value: string): void
    {
        this.attributes.set(name, String(value));
    }

    getAttribute(name: string): string | null
    {
        return this.attributes.get(name) ?? null;
    }

    hasAttribute(name: string): boolean
    {
        return this.attributes.has(name);
    }

    removeAttribute(name: string): void
    {
        this.attributes.delete(name);
    }

    append(...nodes: (FakeNode | string)[]): void
    {
        // Like the real append(): a string becomes a text node, never markup.
        for (const node of nodes)
        {
            this.children.push(typeof node === 'string' ? new FakeText(node) : node);
        }
    }

    /** Like the real insertBefore(): `node` goes before `reference`, or at the end when it is null. */
    insertBefore(node: FakeNode, reference: FakeNode | null): FakeNode
    {
        const at = reference === null ? -1 : this.children.indexOf(reference);
        if (reference !== null && at < 0)
        {
            throw new Error('fake DOM: insertBefore reference is not a child');
        }
        if (at < 0)
        {
            this.children.push(node);
        }
        else
        {
            this.children.splice(at, 0, node);
        }
        return node;
    }

    replaceChildren(...nodes: (FakeNode | string)[]): void
    {
        this.ownText = '';
        this.children = [];
        this.append(...nodes);
    }

    addEventListener(type: string, listener: FakeListener): void
    {
        this.listeners.add(type, listener);
    }

    removeEventListener(type: string, listener: FakeListener): void
    {
        this.listeners.remove(type, listener);
    }

    /** Like the real click(): fires 'click' at this element. */
    click(): void
    {
        this.clicks++;
        this.listeners.fire('click', this, {});
    }

    /** The options of the last focus() call (undefined: none given). */
    focusOptions: unknown = undefined;

    /** Like the real focus(), recorded only (the fake has no active element). */
    focus(options?: unknown): void
    {
        this.focuses++;
        this.focusOptions = options;
    }

    /** Where getBoundingClientRect() says this element is (set by a test; the fake has no layout). */
    rect = { top: 0, bottom: 0 };

    /** Like the real getBoundingClientRect(), from `rect` (top and bottom only). */
    getBoundingClientRect(): { top: number; bottom: number }
    {
        return { ...this.rect };
    }

    /** The options of each scrollIntoView() call, in order. */
    readonly scrollIntoViewCalls: unknown[] = [];

    /** Like the real scrollIntoView(), recorded only. */
    scrollIntoView(options?: unknown): void
    {
        this.scrollIntoViewCalls.push(options);
    }

    /** Test side: fires an event at this element's own listeners (target = this). */
    fire(type: string, init: Record<string, unknown> = {}): FakeEvent
    {
        return this.listeners.fire(type, this, init);
    }

    /** True for this element itself or any node below it (like Node.contains). */
    contains(node: unknown): boolean
    {
        return node === this || this.children.some((c) => c === node || (c instanceof FakeElement && c.contains(node)));
    }

    /** Every element below this one, depth first, in document order. */
    descendants(): FakeElement[]
    {
        return this.children.flatMap((c) => (c instanceof FakeElement ? [c, ...c.descendants()] : []));
    }
}

export class FakeDocument
{
    title = '';
    readonly documentElement = new FakeElement('html');
    readonly body = new FakeElement('body');
    /** Set by a test (focus() does not change it): `body` stands for "focus lost". */
    activeElement: FakeElement | null = null;
    readonly created: FakeElement[] = [];
    readonly listeners = new Listeners();

    addEventListener(type: string, listener: FakeListener): void
    {
        this.listeners.add(type, listener);
    }

    removeEventListener(type: string, listener: FakeListener): void
    {
        this.listeners.remove(type, listener);
    }

    /** Test side: dispatches an event to the document's listeners (pass `target` in `init`, e.g. for 'focusin'). */
    fire(type: string, init: Record<string, unknown> = {}): FakeEvent
    {
        return this.listeners.fire(type, this, init);
    }

    createElement(tag: string): FakeElement
    {
        const element = new FakeElement(tag);
        this.created.push(element);
        return element;
    }
}
