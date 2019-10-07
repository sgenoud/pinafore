import {
  assets as __assets__,
  shell as __shell__,
  routes as __routes__
} from '../__sapper__/service-worker.js'

import {
  get,
  post
} from './routes/_utils/ajax'

const timestamp = process.env.SAPPER_TIMESTAMP
const ASSETS = `assets_${timestamp}`
const WEBPACK_ASSETS = `webpack_assets_${timestamp}`

// `static` is an array of everything in the `static` directory
const assets = __assets__
  .map(file => file.startsWith('/') ? file : `/${file}`)
  .filter(filename => !filename.endsWith('.map'))
  .filter(filename => filename !== '/robots.txt')
  .filter(filename => !filename.includes('traineddata.gz')) // Tesseract already caches it in IDB
  .filter(filename => !filename.endsWith('.webapp')) // KaiOS manifest

// `shell` is an array of all the files generated by webpack
// also contains '/index.html' for some reason
const webpackAssets = __shell__
  .filter(filename => !filename.endsWith('.map')) // don't bother with sourcemaps
  .filter(filename => !filename.includes('tesseract-core.wasm')) // cache on-demand

// `routes` is an array of `{ pattern: RegExp }` objects that
// match the pages in your src
const routes = __routes__

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    await Promise.all([
      caches.open(WEBPACK_ASSETS).then(cache => cache.addAll(webpackAssets)),
      caches.open(ASSETS).then(cache => cache.addAll(assets))
    ])
    // We shouldn't have to do this, but the previous page could be an old one,
    // which would not send us a postMessage to skipWaiting().
    // See https://github.com/nolanlawson/pinafore/issues/1243
    self.skipWaiting()
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys()

    // delete old asset/ondemand caches
    for (const key of keys) {
      if (key !== ASSETS &&
        !key.startsWith('webpack_assets_')) {
        await caches.delete(key)
      }
    }

    // for webpack static, keep the two latest builds because we may need
    // them when the service worker has installed but the page has not
    // yet reloaded (e.g. when it gives the toast saying "please reload"
    // but then you don't refresh and instead load an async chunk)
    const webpackKeysToDelete = keys
      .filter(key => key.startsWith('webpack_assets_'))
      .sort((a, b) => {
        const aTimestamp = parseInt(a.substring(15), 10)
        const bTimestamp = parseInt(b.substring(15), 10)
        return bTimestamp < aTimestamp ? -1 : 1
      })
      .slice(2)

    for (const key of webpackKeysToDelete) {
      await caches.delete(key)
    }

    await self.clients.claim()
  })())
})

// from https://stackoverflow.com/questions/54138601/cant-access-arraybuffer-on-rangerequest/54207122
const returnRangeRequest = request =>
  fetch(request, { headers: {}, mode: 'cors', credentials: 'omit' })
    .then(res => {
      return res.arrayBuffer()
    })
    .then(arrayBuffer => {
      const bytes = /^bytes=(\d+)-(\d+)?$/g.exec(request.headers.get('range'))
      if (bytes) {
        const start = Number(bytes[1])
        const end = Number(bytes[2]) || arrayBuffer.byteLength - 1

        return new self.Response(arrayBuffer.slice(start, end + 1), {
          status: 206,
          statusText: 'Partial Content',
          headers: [
            ['Content-Range', `bytes ${start}-${end}/${arrayBuffer.byteLength}`]
          ]
        })
      } else {
        return new self.Response(null, {
          status: 416,
          statusText: 'Range Not Satisfiable',
          headers: [['Content-Range', `*/${arrayBuffer.byteLength}`]]
        })
      }
    })

self.addEventListener('fetch', event => {
  const req = event.request
  const url = new URL(req.url)

  // don't try to handle e.g. data: URIs
  if (!url.protocol.startsWith('http')) {
    return
  }

  event.respondWith((async () => {
    const sameOrigin = url.origin === self.origin

    if (sameOrigin) {
      // always serve webpack-generated resources and
      // static from the cache if possible
      const response = await caches.match(req)
      if (response) {
        return response
      }

      if (/tesseract-core\.wasm/.test(url.pathname)) {
        // cache this on-demand
        const response = await fetch(req)
        if (response && response.status >= 200 && response.status < 300) {
          const clonedResponse = response.clone()
          /* no await */ caches.open(WEBPACK_ASSETS).then(cache => cache.put(req, clonedResponse))
        }
        return response
      }

      // for routes, serve the /service-worker-index.html file from the most recent
      // static cache
      if (routes.find(route => route.pattern.test(url.pathname))) {
        const response = await caches.match('/service-worker-index.html')
        if (response) {
          return response
        }
      }
    }

    // for everything else, go network-only

    // range request need to be be patched with a 206 response to satisfy
    // Safari (https://stackoverflow.com/questions/52087208)
    if (event.request.headers.get('range')) {
      return returnRangeRequest(req)
    }

    return fetch(req)
  })())
})

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    const data = event.data.json()
    const { origin } = new URL(data.icon)

    try {
      const notification = await get(`${origin}/api/v1/notifications/${data.notification_id}`, {
        Authorization: `Bearer ${data.access_token}`
      }, { timeout: 2000 })

      await showRichNotification(data, notification)
    } catch (e) {
      await showSimpleNotification(data)
    }
  })())
})

async function showSimpleNotification (data) {
  await self.registration.showNotification(data.title, {
    icon: data.icon,
    body: data.body,
    data: {
      url: `${self.origin}/notifications`
    }
  })
}

async function showRichNotification (data, notification) {
  const { icon, body } = data
  const tag = notification.id
  const { origin } = self.location
  const badge = '/icon-push-badge.png'

  switch (notification.type) {
    case 'follow': {
      await self.registration.showNotification(data.title, {
        badge,
        icon,
        body,
        tag,
        data: {
          url: `${origin}/accounts/${notification.account.id}`
        }
      })
      break
    }
    case 'reblog':
    case 'favourite':
    case 'poll': {
      await self.registration.showNotification(data.title, {
        badge,
        icon,
        body,
        tag,
        data: {
          url: `${origin}/statuses/${notification.status.id}`
        }
      })
      break
    }
    case 'mention': {
      const isPublic = ['public', 'unlisted'].includes(notification.status.visibility)
      const actions = [
        isPublic && {
          action: 'reblog',
          icon: '/icon-push-fa-retweet.png', // generated manually from font-awesome-svg
          title: 'Boost'
        },
        {
          action: 'favourite',
          icon: '/icon-push-fa-star.png', // generated manually from font-awesome-svg
          title: 'Favorite'
        }
      ].filter(Boolean)

      await self.registration.showNotification(data.title, {
        badge,
        icon,
        body,
        tag,
        data: {
          instance: new URL(data.icon).origin,
          status_id: notification.status.id,
          access_token: data.access_token,
          url: `${origin}/statuses/${notification.status.id}`
        },
        actions
      })
      break
    }
  }
}

const cloneNotification = notification => {
  const clone = {}

  for (const k in notification) {
    // deliberately not doing a hasOwnProperty check, but skipping
    // functions and null props like onclick and onshow and showTrigger
    if (typeof notification[k] !== 'function' && notification[k] !== null) {
      clone[k] = notification[k]
    }
  }

  return clone
}

const updateNotificationWithoutAction = (notification, action) => {
  const newNotification = cloneNotification(notification)

  newNotification.actions = newNotification.actions.filter(item => item.action !== action)

  return self.registration.showNotification(newNotification.title, newNotification)
}

self.addEventListener('notificationclick', event => {
  event.waitUntil((async () => {
    switch (event.action) {
      case 'reblog': {
        const url = `${event.notification.data.instance}/api/v1/statuses/${event.notification.data.status_id}/reblog`
        await post(url, null, {
          Authorization: `Bearer ${event.notification.data.access_token}`
        })
        await updateNotificationWithoutAction(event.notification, 'reblog')
        break
      }
      case 'favourite': {
        const url = `${event.notification.data.instance}/api/v1/statuses/${event.notification.data.status_id}/favourite`
        await post(url, null, {
          Authorization: `Bearer ${event.notification.data.access_token}`
        })
        await updateNotificationWithoutAction(event.notification, 'favourite')
        break
      }
      default: {
        await self.clients.openWindow(event.notification.data.url)
        await event.notification.close()
        break
      }
    }
  })())
})

self.addEventListener('message', (event) => {
  switch (event.data) {
    case 'skip-waiting':
      self.skipWaiting()
      break
  }
})
