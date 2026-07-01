// Shared detection library for CustomTabTitles / ArticleMetadataBanner.
// Not a standalone userscript — host this file (GitHub raw / jsDelivr) and
// pull it in via @require from each consumer script.
//
// Exposes window.ArticleMetaLib = { utils, config, scan(host) }.
// scan() returns a metadata object or null:
//   { source, pageType, date, pub, headline, author, followers }
// Consumers decide how to format and display this; this file only detects.

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

        // Converts an ISO date string (YYYY-MM-DD) to "Month DD, YYYY".
        // Returns the input unchanged if it doesn't match that shape.
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
        }
    };

    // =========================================================================
    // SITE HANDLERS
    // Each: { match(host) => bool, handle() => metadata | Promise<metadata> | null }
    // =========================================================================

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

                function getDate() {
                    const meta = utils.normaliseDate(
                        utils.getMeta('og:updated_time') || utils.getMeta('article:published_time')
                    );
                    if (meta) return meta;
                    const el = document.querySelector('article time[datetime], main time[datetime], time[datetime]');
                    if (el) return utils.normaliseDate(el.getAttribute('datetime'));
                    for (const script of document.querySelectorAll('script:not([src])')) {
                        const text = script.textContent;
                        if (!text.includes('taken_at')) continue;
                        let m = text.match(/"taken_at_timestamp"\s*:\s*(\d+)/);
                        if (!m) m = text.match(/"taken_at"\s*:\s*(\d+)/);
                        if (m) return utils.normaliseDate(m[1]);
                    }
                    return null;
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
                    const m = document.title.match(/@([\w._]+)/);
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
                    return { source: 'instagram', pageType: 'profile', author: username, followers, pub: 'Instagram' };
                }

                const date = getDate();
                if (!date) return null;
                return { source: 'instagram', pageType, date, pub: 'Instagram', author: getUsername() };
            }
        },

        {
            match: host => host.includes('facebook.com'),

            handle() {
                let date = utils.normaliseDate(
                    utils.getMeta('article:published_time') || utils.getMeta('og:updated_time')
                );
                if (!date) {
                    for (const script of document.querySelectorAll('script:not([src])')) {
                        const text = script.textContent;
                        if (!text.includes('publish_time') && !text.includes('creation_time')) continue;
                        let m = text.match(/"publish_time"\s*:\s*(\d+)/);
                        if (!m) m = text.match(/"creation_time"\s*:\s*(\d+)/);
                        if (m) { date = utils.normaliseDate(m[1]); break; }
                    }
                }
                if (!date) return null;
                const pub = utils.decodeEntities(utils.getMeta('og:site_name') || 'Facebook');
                const headline = utils.truncate(utils.decodeEntities(document.title), 60);
                return { source: 'facebook', pageType: 'post', date, pub, headline };
            }
        },

        {
            match: host => host.includes('nytimes.com'),

            handle() {
                const date = utils.normaliseDate(utils.getMeta('article:published_time'));
                if (!date) return null;
                const headline = utils.truncate(utils.decodeEntities(utils.getMeta('og:title') || document.title), 60);
                return { source: 'nytimes', pageType: 'article', date, pub: 'NYT', headline };
            }
        },

        {
            match: host => host.includes('bloomberg.com'),

            handle() {
                const date = utils.normaliseDate(
                    utils.getMeta('datePublished') || utils.getMeta('article:published_time')
                );
                if (!date) return null;
                const headline = utils.truncate(utils.decodeEntities(utils.getMeta('og:title') || document.title), 60);
                return { source: 'bloomberg', pageType: 'article', date, pub: 'Bloomberg', headline };
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

                function getDate() {
                    for (const script of document.querySelectorAll('script#__UNIVERSAL_DATA_FOR_REHYDRATION__')) {
                        try {
                            const data = JSON.parse(script.textContent);
                            const videoDetail = data?.['__DEFAULT_SCOPE__']?.['webapp.video-detail']?.itemInfo?.itemStruct;
                            if (videoDetail?.createTime) return utils.normaliseDate(String(videoDetail.createTime));
                        } catch {}
                    }
                    return utils.normaliseDate(utils.getMeta('og:updated_time') || utils.getMeta('article:published_time'));
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
                    return { source: 'tiktok', pageType: 'profile', author: username, followers, pub: 'TikTok' };
                }

                const date = getDate();
                if (!date) return null;
                return { source: 'tiktok', pageType, date, pub: 'TikTok', author: getUsername() };
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

                function getPubDate() {
                    return utils.normaliseDate(
                        utils.getMeta('article:published_time') || utils.getMeta('og:updated_time') ||
                        utils.getMeta('publish-date') || utils.getMeta('pubdate') ||
                        utils.getMeta('date') || utils.getMeta('datePublished')
                    ) || (() => {
                        const el = document.querySelector('time[datetime]');
                        return el ? utils.normaliseDate(el.getAttribute('datetime')) : null;
                    })();
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
                        return { source: 'webarchive', subtype: 'instagram', date: getPubDate() || archiveDate, pub: 'Instagram (archived)', author: username };
                    }
                }

                if (originalDomain?.includes('tiktok.com')) {
                    const parts = originalPath.split('/').filter(Boolean);
                    const username = parts[0]?.startsWith('@') ? parts[0].slice(1) : null;
                    if (username) {
                        return { source: 'webarchive', subtype: 'tiktok', date: getPubDate() || archiveDate, pub: 'TikTok (archived)', author: username };
                    }
                }

                if (originalDomain?.includes('facebook.com')) {
                    const siteName = utils.decodeEntities(utils.getMeta('og:site_name') || 'Facebook');
                    const headline = utils.truncate(utils.decodeEntities(document.title), 60);
                    return { source: 'webarchive', subtype: 'facebook', date: getPubDate() || archiveDate, pub: siteName, headline };
                }

                const pub = utils.decodeEntities(utils.getMeta('og:site_name'));
                const pubDate = getPubDate();
                if (!isException && pub && pubDate) {
                    const headline = utils.truncate(
                        utils.decodeEntities(utils.getMeta('og:title') || utils.getMeta('twitter:title') || document.title),
                        60
                    );
                    return { source: 'webarchive', subtype: 'article', date: pubDate, pub, headline };
                }

                const titleFallback = utils.truncate(utils.decodeEntities(document.title), 60);
                return { source: 'webarchive', subtype: 'fallback', date: archiveDate, headline: titleFallback };
            }
        }

    ];

    function globalFallback() {
        let date = null;
        for (const selector of config.globalDateSelectors) {
            const el = document.querySelector(selector);
            if (!el) continue;
            date = utils.normaliseDate(utils.getRawDateString(el));
            if (date) break;
        }
        if (!date) return null;

        const pub = utils.decodeEntities(utils.getMeta('og:site_name'));
        const headline = utils.truncate(
            utils.decodeEntities(utils.getMeta('og:title') || utils.getMeta('twitter:title') || ''),
            60
        );
        return { source: 'fallback', pageType: 'fallback', date, pub: pub || null, headline: headline || null };
    }

    function getStandardFields() {
        const author =
            utils.getMeta('author') ||
            utils.getMeta('article:author') ||
            utils.getMeta('twitter:creator') ||
            utils.getMeta('parsely-author') ||
            null;
        const section = utils.getMeta('article:section') || utils.getMeta('parsely-section') || null;
        const modified = utils.normaliseDate(utils.getMeta('article:modified_time'));
        return { author, section, modified };
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
            if (!metadata.section && std.section) metadata.section = utils.decodeEntities(std.section);
            if (!metadata.modified && std.modified) metadata.modified = std.modified;
        }

        return metadata;
    }

    window.ArticleMetaLib = { utils, config, scan };

})();
