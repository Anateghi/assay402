---
title: "assay-fetch: our crawler"
description: "How Assay's fetcher identifies itself, honors robots.txt (RFC 9309), and how site owners can opt out."
order: 7
nav: "Crawler (assay-fetch)"
---

# assay-fetch: our crawler

Assay fetches pages only when an agent asks for a specific URL. It does not crawl or follow links on its own.

- **User-Agent:** `assay-fetch/0.1 (+https://github.com/Anateghi/assay402#crawler)`
- **robots.txt token:** `assay-fetch`. We apply the most specific group that matches our token, otherwise `*`, following [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309): longest match wins, `Allow` wins ties. If robots.txt returns a 5xx error, we treat the site as disallowed.
- **No circumvention:** no logins, no CAPTCHA solving, no browser impersonation, no private or internal network addresses.
- **Caching:** robots.txt and extracted pages are cached for one hour.

## Opting out

```
User-agent: assay-fetch
Disallow: /
```

Reports and questions: [github.com/Anateghi/assay402/issues](https://github.com/Anateghi/assay402/issues).
