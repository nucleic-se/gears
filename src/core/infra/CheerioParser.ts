import * as cheerio from 'cheerio';
import { IHtmlParser, IElement } from '../interfaces.js';

class CheerioElement implements IElement {
    // Using any for internal cheerio objects to avoid type conflicts between @types/cheerio versions
    constructor(private $: any, private element: any) { }

    text(): string {
        return this.element.text();
    }

    attr(name: string): string | null {
        return this.element.attr(name) ?? null;
    }

    query(selector: string): IElement[] {
        const elements = this.element.find(selector);
        return elements.toArray().map((el: any) => new CheerioElement(this.$, this.$(el)));
    }

    queryOne(selector: string): IElement | null {
        const el = this.element.find(selector).first();
        if (el.length === 0) return null;
        return new CheerioElement(this.$, el);
    }

    html(): string | null {
        return this.element.html();
    }

    remove(selector: string): void {
        this.element.find(selector).remove();
    }
}

export class CheerioParser implements IHtmlParser {
    parse(html: string): IElement {
        const $ = cheerio.load(html);
        return new CheerioElement($, $.root());
    }
}
