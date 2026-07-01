// Shared detection library for CustomTabTitles / ArticleMetadataBanner.
// Host this file and pull it in via @require from each consumer script.
// window.ArticleMetaLib = { utils, config, scan(host), resetCleanTitle }
// scan() returns null or:
//   { source, pageType, date, utcTime, pub, pubUrl, headline, author, authorUrl,
//     followers, section, modified, language }
// utcTime/language only ever come from unambiguous sources. Headlines are
// returned at full length; truncation is a consumer-side concern.

(function () {
    'use strict';

    const config = {
        globalDateSelectors: [
            'meta[property="article:published_time"]',
            'meta[property="og:published_time"]',
            'meta[name="publish-date"]',
            'meta[name="pubdate"]',
            'meta[name="date"]',
            'meta[itemprop="datePublished"]',
            'time[datetime]',
            'time'
        ]
    };

    // Snapshot of document.title before CustomTabTitles can overwrite it.
    // Captured on first use per page-view; reset on SPA navigation.
    let cleanTitle = null;

    function getCleanTitle() {
        if (cleanTitle === null) cleanTitle = document.title;
        return cleanTitle;
    }

    function resetCleanTitle() {
        cleanTitle = null;
    }

    const utils = {
        getMeta(key) {
            const el = document.querySelector(
                `meta[property="${key}"], meta[name="${key}"], meta[itemprop="${key}"]`
            );
            return el ? el.getAttribute('content') : null;
        },

        normaliseDate(raw) {
            if (!raw) return null;
            const s = String(raw).trim();

            if (/^\d{9,11}$/.test(s)) {
                const d = new Date(parseInt(s, 10) * 1000);
                if (!isNaN(d.getTime()) && d.getFullYear() > 1970) return d.toISOString().slice(0, 10);
            }

            if (
                /\d{4}[-/]\d{2}[-/]\d{2}/.test(s) ||
                /\d{1,2}\s+[a-z]{3,9}\s+\d{4}/i.test(s) ||
                /[a-z]{3,9}\s+\d{1,2},?\s+\d{4}/i.test(s)
            ) {
                const d = new Date(s);
                if (!isNaN(d.getTime()) && d.getFullYear() > 1970) return d.toISOString().slice(0, 10);
            }

            let m = s.match(/\b(\d{4})[-/.](\d{2})[-/.](\d{2})\b/);
            if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;

            m = s.match(/\b(\d{2})[-/.](\d{2})[-/.](\d{4})\b/);
            if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;

            return null;
        },

        getRawDateString(el) {
            if (!el) return null;
            return el.tagName === 'META'
                ? el.getAttribute('content')
                : el.getAttribute('datetime') || el.textContent.trim();
        },

        // UTC "HH:MM", only when unambiguous: unix timestamp or ISO 8601
        // with explicit Z/offset. Returns null rather than guessing.
        getUtcTime(raw) {
            if (!raw) return null;
            const s = String(raw).trim();

            if (/^\d{9,11}$/.test(s)) {
                const d = new Date(parseInt(s, 10) * 1000);
                if (!isNaN(d.getTime()) && d.getFullYear() > 1970) return d.toISOString().slice(11, 16);
            }

            if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
                const d = new Date(s);
                if (!isNaN(d.getTime())) return d.toISOString().slice(11, 16);
            }

            return null;
        },

        extractDateTime(raw) {
            return { date: this.normaliseDate(raw), utcTime: this.getUtcTime(raw) };
        },

        parseFollowerString(str) {
            if (!str) return null;
            const s = str.replace(/,/g, '').trim();
            const multipliers = { k: 1e3, m: 1e6, b: 1e9 };
            const match = s.match(/^([\d.]+)([kmb])?$/i);
            if (!match) return null;
            return Math.round(parseFloat(match[1]) * (match[2] ? multipliers[match[2].toLowerCase()] : 1));
        },

        formatFollowers(n) {
            if (n == null) return null;
            if (n >= 1e9) return `${parseFloat((n / 1e9).toFixed(1))}B`;
            if (n >= 1e6) return `${parseFloat((n / 1e6).toFixed(1))}M`;
            if (n >= 1e3) return `${parseFloat((n / 1e3).toFixed(1))}K`;
            return String(n);
        },

        decodeEntities(str) {
            if (!str || !str.includes('&')) return str;
            const el = document.createElement('textarea');
            el.innerHTML = str;
            return el.value;
        },

        truncate(str, max) {
            if (!str) return '';
            const s = str.trim();
            if (s.length <= max) return s;
            const cut = s.slice(0, max);
            const lastSpace = cut.lastIndexOf(' ');
            return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
        },

        // YYYY-MM-DD to "Month DD, YYYY". Unchanged if input doesn't match.
        formatDateLong(isoDate) {
            if (!isoDate) return null;
            const parts = isoDate.split('-');
            if (parts.length !== 3) return isoDate;
            const months = [
                'January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'
            ];
            const [y, mo, d] = parts;
            const idx = parseInt(mo, 10) - 1;
            if (idx < 0 || idx > 11) return isoDate;
            return `${months[idx]} ${d}, ${y}`;
        },

        // Rejects meta-tag values that are a URL/handle rather than a name.
        looksLikeUrl(str) {
            if (!str) return false;
            return /^https?:\/\//i.test(str) || /^www\./i.test(str) || /\.[a-z]{2,6}\//i.test(str);
        }
    };

    // { match(host) => bool, handle() => metadata | Promise<metadata> | null }
    const siteHandlers = [

        {
            match: host => host.includes('instagram.com'),

            async handle() {
                const reserved = new Set([
                    'p', 'reel', 'reels', 'stories', 'explore',
                    'direct', 'accounts', 'emails', 'developer', 'tv'
                ]);

                function getPageType() {
                    const parts = window.location.pathname.split('/').filter(Boolean);
                    if (!parts.length) return 'home';
                    if (parts[0] === 'reel' || parts[0] === 'reels') return 'reel';
                    if (parts[0] === 'p') return 'post';
                    if (parts.length === 1 && !reserved.has(parts[0])) return 'profile';
                    return 'other';
                }

                function getDateInfo() {
                    const rawMeta = utils.getMeta('og:updated_time') || utils.getMeta('article:published_time');
                    if (rawMeta) {
                        const info = utils.extractDateTime(rawMeta);
                        if (info.date) return info;
                    }
                    const el = document.querySelector('article time[datetime], main time[datetime], time[datetime]');
                    if (el) {
                        const info = utils.extractDateTime(el.getAttribute('datetime'));
                        if (info.date) return info;
                    }
                    for (const script of document.querySelectorAll('script:not([src])')) {
                        const text = script.textContent;
                        if (!text.includes('taken_at')) continue;
                        let m = text.match(/"taken_at_timestamp"\s*:\s*(\d+)/);
                        if (!m) m = text.match(/"taken_at"\s*:\s*(\d+)/);
                        if (m) return utils.extractDateTime(m[1]);
                    }
                    return { date: null, utcTime: null };
                }

                function usernameFromOgUrl() {
                    const url = utils.getMeta('og:url');
                    if (!url) return null;
                    try {
                        const parts = new URL(url).pathname.split('/').filter(Boolean);
                        if (parts.length >= 2 && !reserved.has(parts[0])) return parts[0];
                    } catch {}
                    return null;
                }

                function usernameFromJsonLd() {
                    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
                        try {
                            const data = JSON.parse(script.textContent);
                            const entries = Array.isArray(data['@graph']) ? data['@graph'] : [data];
                            for (const entry of entries) {
                                const u =
                                    entry.author?.identifier?.value ||
                                    entry.author?.alternateName?.replace(/^@/, '') ||
                                    entry.author?.name ||
                                    (entry['@type'] === 'Person' && entry.identifier?.value) ||
                                    null;
                                if (u) return u;
                            }
                        } catch {}
                    }
                    return null;
                }

                function usernameFromSharedData() {
                    for (const script of document.querySelectorAll('script:not([src])')) {
                        if (!script.textContent.includes('window._sharedData')) continue;
                        try {
                            const m = script.textContent.match(/window\._sharedData\s*=\s*(\{.+?\});/);
                            if (!m) continue;
                            const data = JSON.parse(m[1]);
                            return (
                                data?.entry_data?.PostPage?.[0]?.graphql?.shortcode_media?.owner?.username ||
                                data?.entry_data?.ProfilePage?.[0]?.graphql?.user?.username ||
                                null
                            );
                        } catch {}
                    }
                    return null;
                }

                function usernameFromInlineJson() {
                    const ownerPattern = /"(?:owner|author|user)"\s*:\s*\{[^}]*"username"\s*:\s*"([\w._]+)"/;
                    for (const script of document.querySelectorAll('script:not([src])')) {
                        const text = script.textContent;
                        if (!text.includes('"username"')) continue;
                        const m = text.match(ownerPattern);
                        if (m) return m[1];
                    }
                    return null;
                }

                function usernameFromUrl() {
                    const segments = window.location.pathname.split('/').filter(Boolean);
                    if (!segments.length || reserved.has(segments[0])) return null;
                    return segments.length === 1 ? segments[0] : null;
                }

                function usernameFromDom() {
                    const selectors = [
                        'article header a[role="link"]',
                        'article header a',
                        'main header a[role="link"]',
                        'main header a',
                        '[role="dialog"] header a[role="link"]',
                        '[role="dialog"] header a',
                        'h2 a[href]',
                        'h1 a[href]'
                    ];
                    for (const sel of selectors) {
                        for (const link of document.querySelectorAll(sel)) {
                            const href = (link.getAttribute('href') || '').split('/').filter(Boolean)[0];
                            if (!href || reserved.has(href) || !/^[\w._]{1,30}$/.test(href)) continue;
                            const text = link.textContent.trim();
                            if (!text || text === href || text === `@${href}`) return href;
                        }
                    }
                    return null;
                }

                function usernameFromTitle() {
                    const m = getCleanTitle().match(/@([\w._]+)/);
                    return m ? m[1] : null;
                }

                function getUsername() {
                    return (
                        usernameFromOgUrl() ||
                        usernameFromJsonLd() ||
                        usernameFromSharedData() ||
                        usernameFromDom() ||
                        usernameFromInlineJson() ||
                        usernameFromUrl() ||
                        usernameFromTitle()
                    );
                }

                function followersFromDesc(desc) {
                    if (!desc) return null;
                    const m = desc.match(/([\d,.]+[KMBkmb]?)\s+Followers/i);
                    return m ? utils.formatFollowers(utils.parseFollowerString(m[1])) : null;
                }

                async function fetchFollowers(username) {
                    try {
                        const res = await fetch(`/${username}/`, { credentials: 'include' });
                        if (!res.ok) return null;
                        const html = await res.text();
                        const m = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]+)"/);
                        return m ? followersFromDesc(m[1]) : null;
                    } catch { return null; }
                }

                const pageType = getPageType();

                if (pageType === 'profile') {
                    const username = getUsername();
                    if (!username) return null;
                    const followers = followersFromDesc(utils.getMeta('og:description')) || await fetchFollowers(username);
                    return {
                        source: 'instagram', pageType: 'profile', author: username, followers,
                        pub: 'Instagram', pubUrl: 'https://www.instagram.com/',
                        authorUrl: `https://www.instagram.com/${username}/`
                    };
                }

                const date = getDateInfo();
                if (!date.date) return null;
                const username = getUsername();
                return {
                    source: 'instagram', pageType, date: date.date, utcTime: date.utcTime, pub: 'Instagram', author: username,
                    pubUrl: 'https://www.instagram.com/',
                    authorUrl: username ? `https://www.instagram.com/${username}/` : null
                };
            }
        },

        {
            match: host => host.includes('facebook.com'),

            handle() {
                let date = null;
                let utcTime = null;

                const metaRaw = utils.getMeta('article:published_time') || utils.getMeta('og:updated_time');
                if (metaRaw) {
                    const info = utils.extractDateTime(metaRaw);
                    date = info.date;
                    utcTime = info.utcTime;
                }
                if (!date) {
                    for (const script of document.querySelectorAll('script:not([src])')) {
                        const text = script.textContent;
                        if (!text.includes('publish_time') && !text.includes('creation_time')) continue;
                        let m = text.match(/"publish_time"\s*:\s*(\d+)/);
                        if (!m) m = text.match(/"creation_time"\s*:\s*(\d+)/);
                        if (m) {
                            const info = utils.extractDateTime(m[1]);
                            date = info.date;
                            utcTime = info.utcTime;
                            break;
                        }
                    }
                }
                if (!date) return null;
                const pub = utils.decodeEntities(utils.getMeta('og:site_name') || 'Facebook');
                const headline = utils.decodeEntities(getCleanTitle());

                const ignoredSlugs = new Set(['permalink.php', 'watch', 'groups', 'photo.php', 'story.php', 'events']);
                let pubUrl = null;
                const ogUrl = utils.getMeta('og:url');
                if (ogUrl) {
                    try {
                        const slug = new URL(ogUrl).pathname.split('/').filter(Boolean)[0];
                        if (slug && !ignoredSlugs.has(slug)) pubUrl = `https://www.facebook.com/${slug}`;
                    } catch {}
                }

                return { source: 'facebook', pageType: 'post', date, utcTime, pub, headline, pubUrl };
            }
        },

        {
            match: host => host.includes('nytimes.com'),

            handle() {
                const raw = utils.getMeta('article:published_time');
                const { date, utcTime } = utils.extractDateTime(raw);
                if (!date) return null;
                const headline = utils.decodeEntities(utils.getMeta('og:title') || getCleanTitle());
                return { source: 'nytimes', pageType: 'article', date, utcTime, pub: 'NYT', headline, pubUrl: 'https://www.nytimes.com' };
            }
        },

        {
            match: host => host.includes('bloomberg.com'),

            handle() {
                const raw = utils.getMeta('datePublished') || utils.getMeta('article:published_time');
                const { date, utcTime } = utils.extractDateTime(raw);
                if (!date) return null;
                const headline = utils.decodeEntities(utils.getMeta('og:title') || getCleanTitle());
                return { source: 'bloomberg', pageType: 'article', date, utcTime, pub: 'Bloomberg', headline, pubUrl: 'https://www.bloomberg.com' };
            }
        },

        {
            match: host => host.includes('tiktok.com'),

            handle() {
                function getPageType() {
                    const parts = window.location.pathname.split('/').filter(Boolean);
                    if (parts.length >= 2 && parts[0].startsWith('@') && parts[1] === 'video') return 'video';
                    if (parts.length === 1 && parts[0].startsWith('@')) return 'profile';
                    return 'other';
                }

                function getUsername() {
                    const url = utils.getMeta('og:url');
                    if (url) {
                        try {
                            const parts = new URL(url).pathname.split('/').filter(Boolean);
                            if (parts[0]?.startsWith('@')) return parts[0].slice(1);
                        } catch {}
                    }
                    const parts = window.location.pathname.split('/').filter(Boolean);
                    if (parts[0]?.startsWith('@')) return parts[0].slice(1);
                    const title = utils.getMeta('og:title') || '';
                    const m = title.match(/^([\w._]+)\s+on\s+TikTok/i);
                    return m ? m[1] : null;
                }

                function getDateInfo() {
                    for (const script of document.querySelectorAll('script#__UNIVERSAL_DATA_FOR_REHYDRATION__')) {
                        try {
                            const data = JSON.parse(script.textContent);
                            const videoDetail = data?.['__DEFAULT_SCOPE__']?.['webapp.video-detail']?.itemInfo?.itemStruct;
                            if (videoDetail?.createTime) return utils.extractDateTime(String(videoDetail.createTime));
                        } catch {}
                    }
                    for (const script of document.querySelectorAll('script#SIGI_STATE')) {
                        try {
                            const data = JSON.parse(script.textContent);
                            const items = data?.ItemModule ? Object.values(data.ItemModule) : [];
                            if (items[0]?.createTime) return utils.extractDateTime(String(items[0].createTime));
                        } catch {}
                    }
                    const rawMeta = utils.getMeta('og:updated_time') || utils.getMeta('article:published_time') || utils.getMeta('og:video:release_date');
                    return utils.extractDateTime(rawMeta);
                }

                function followersFromDesc(desc) {
                    if (!desc) return null;
                    const m = desc.match(/([\d,.]+[KMBkmb]?)\s+Followers/i);
                    return m ? utils.formatFollowers(utils.parseFollowerString(m[1])) : null;
                }

                const pageType = getPageType();

                if (pageType === 'profile') {
                    const username = getUsername();
                    if (!username) return null;
                    const followers = followersFromDesc(utils.getMeta('og:description'));
                    return {
                        source: 'tiktok', pageType: 'profile', author: username, followers,
                        pub: 'TikTok', pubUrl: 'https://www.tiktok.com/',
                        authorUrl: `https://www.tiktok.com/@${username}`
                    };
                }

                const date = getDateInfo();
                if (!date.date && pageType !== 'video') return null;
                const username = getUsername();
                return {
                    source: 'tiktok', pageType, date: date.date, utcTime: date.utcTime, pub: 'TikTok', author: username,
                    pubUrl: 'https://www.tiktok.com/',
                    authorUrl: username ? `https://www.tiktok.com/@${username}` : null
                };
            }
        },

        {
            match: host => host.includes('web.archive.org'),

            handle() {
                const articleExceptions = ['lush.'];
                const pathMatch = window.location.pathname.match(/^\/web\/(\d{14})\/(https?:\/\/([^/]+)(\/.*)?)?/);
                if (!pathMatch) return null;

                const archiveTs = pathMatch[1];
                const originalDomain = pathMatch[3] || null;
                const originalPath = pathMatch[4] || '/';
                const archiveDate = `${archiveTs.slice(0,4)}-${archiveTs.slice(4,6)}-${archiveTs.slice(6,8)}`;
                const isException = articleExceptions.some(d => originalDomain?.includes(d));

                function getPubDateInfo() {
                    const rawMeta =
                        utils.getMeta('article:published_time') || utils.getMeta('og:updated_time') ||
                        utils.getMeta('publish-date') || utils.getMeta('pubdate') ||
                        utils.getMeta('date') || utils.getMeta('datePublished');
                    if (rawMeta) {
                        const info = utils.extractDateTime(rawMeta);
                        if (info.date) return info;
                    }
                    const el = document.querySelector('time[datetime]');
                    if (el) {
                        const info = utils.extractDateTime(el.getAttribute('datetime'));
                        if (info.date) return info;
                    }
                    return { date: null, utcTime: null };
                }

                if (originalDomain?.includes('instagram.com')) {
                    const igReserved = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'direct', 'accounts', 'tv']);
                    const parts = originalPath.split('/').filter(Boolean);
                    let username = null;
                    try {
                        const u = new URL(utils.getMeta('og:url') || '').pathname.split('/').filter(Boolean);
                        if (u.length >= 2 && !igReserved.has(u[0])) username = u[0];
                    } catch {}
                    if (!username && parts.length >= 2 && !igReserved.has(parts[0])) username = parts[0];
                    if (username) {
                        const pd = getPubDateInfo();
                        return {
                            source: 'webarchive', subtype: 'instagram',
                            date: pd.date || archiveDate, utcTime: pd.date ? pd.utcTime : null,
                            pub: 'Instagram (archived)', pubUrl: 'https://www.instagram.com/',
                            author: username, authorUrl: `https://www.instagram.com/${username}/`
                        };
                    }
                }

                if (originalDomain?.includes('tiktok.com')) {
                    const parts = originalPath.split('/').filter(Boolean);
                    const username = parts[0]?.startsWith('@') ? parts[0].slice(1) : null;
                    if (username) {
                        const pd = getPubDateInfo();
                        return {
                            source: 'webarchive', subtype: 'tiktok',
                            date: pd.date || archiveDate, utcTime: pd.date ? pd.utcTime : null,
                            pub: 'TikTok (archived)', pubUrl: 'https://www.tiktok.com/',
                            author: username, authorUrl: `https://www.tiktok.com/@${username}`
                        };
                    }
                }

                if (originalDomain?.includes('facebook.com')) {
                    const siteName = utils.decodeEntities(utils.getMeta('og:site_name') || 'Facebook');
                    const headline = utils.decodeEntities(getCleanTitle());
                    const ignoredSlugs = new Set(['permalink.php', 'watch', 'groups', 'photo.php', 'story.php', 'events']);
                    const slug = originalPath.split('/').filter(Boolean)[0];
                    const pubUrl = slug && !ignoredSlugs.has(slug) ? `https://www.facebook.com/${slug}` : null;
                    const pd = getPubDateInfo();
                    return {
                        source: 'webarchive', subtype: 'facebook',
                        date: pd.date || archiveDate, utcTime: pd.date ? pd.utcTime : null,
                        pub: siteName, headline, pubUrl
                    };
                }

                const pub = utils.decodeEntities(utils.getMeta('og:site_name'));
                const pd = getPubDateInfo();
                if (!isException && pub && pd.date) {
                    const headline = utils.decodeEntities(utils.getMeta('og:title') || utils.getMeta('twitter:title') || getCleanTitle());
                    const pubUrl = originalDomain ? `https://${originalDomain}` : null;
                    return { source: 'webarchive', subtype: 'article', date: pd.date, utcTime: pd.utcTime, pub, headline, pubUrl };
                }

                const titleFallback = utils.decodeEntities(getCleanTitle());
                return { source: 'webarchive', subtype: 'fallback', date: archiveDate, headline: titleFallback };
            }
        }

    ];

    function globalFallback() {
        let date = null;
        let utcTime = null;
        for (const selector of config.globalDateSelectors) {
            const el = document.querySelector(selector);
            if (!el) continue;
            const info = utils.extractDateTime(utils.getRawDateString(el));
            if (info.date) { date = info.date; utcTime = info.utcTime; break; }
        }
        if (!date) return null;

        const pub = utils.decodeEntities(utils.getMeta('og:site_name'));
        const headline = utils.decodeEntities(utils.getMeta('og:title') || utils.getMeta('twitter:title') || '');
        return {
            source: 'fallback', pageType: 'fallback', date, utcTime, pub: pub || null, headline: headline || null,
            pubUrl: pub ? `${window.location.protocol}//${window.location.hostname}` : null
        };
    }

    // Most reliable author source: page-wide JSON-LD (schema.org Article etc).
    function authorFromJsonLd() {
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
            try {
                const data = JSON.parse(script.textContent);
                const entries = Array.isArray(data) ? data : (Array.isArray(data['@graph']) ? data['@graph'] : [data]);
                for (const entry of entries) {
                    let author = entry.author;
                    if (!author) continue;
                    if (Array.isArray(author)) author = author[0];
                    const name = typeof author === 'string' ? author : author.name;
                    if (!name || utils.looksLikeUrl(name)) continue;
                    const url = (typeof author === 'object' && author.url && /^https?:\/\//i.test(author.url))
                        ? author.url : null;
                    return { name, url };
                }
            } catch {}
        }
        return null;
    }

    // html[lang] / og:locale only — explicit, author-declared, no inference.
    function getLanguage() {
        const codePattern = /^[a-zA-Z]{2}([-_][a-zA-Z0-9]{2,8})?$/;

        const htmlLang = document.documentElement.getAttribute('lang');
        if (htmlLang && codePattern.test(htmlLang.trim())) return htmlLang.trim();

        const ogLocale = utils.getMeta('og:locale');
        if (ogLocale && codePattern.test(ogLocale.trim())) return ogLocale.trim().replace('_', '-');

        return null;
    }

    function getStandardFields() {
        const jsonLd = authorFromJsonLd();
        let author = jsonLd?.name || null;
        let authorUrl = jsonLd?.url || null;

        if (!author) {
            const candidate = utils.getMeta('author') || utils.getMeta('article:author');
            if (candidate && !utils.looksLikeUrl(candidate)) author = candidate;
        }

        const section = utils.getMeta('article:section') || utils.getMeta('parsely-section') || null;
        const modified = utils.normaliseDate(utils.getMeta('article:modified_time'));
        const language = getLanguage();
        return { author, authorUrl, section, modified, language };
    }

    async function scan(host) {
        let metadata = null;
        let matched = false;

        for (const { match, handle } of siteHandlers) {
            if (match(host)) { matched = true; metadata = await handle(); break; }
        }
        if (!matched) metadata = globalFallback();

        if (metadata && metadata.pageType !== 'profile') {
            const std = getStandardFields();
            if (!metadata.author && std.author) metadata.author = utils.decodeEntities(std.author);
            if (!metadata.authorUrl && std.authorUrl) metadata.authorUrl = std.authorUrl;
            if (!metadata.section && std.section) metadata.section = utils.decodeEntities(std.section);
            if (!metadata.modified && std.modified) metadata.modified = std.modified;
            if (!metadata.language && std.language) metadata.language = std.language;
        }

        return metadata;
    }

    window.ArticleMetaLib = { utils, config, scan, resetCleanTitle };

})();
