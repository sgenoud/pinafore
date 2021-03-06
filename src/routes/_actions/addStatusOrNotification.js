import { mark, stop } from '../_utils/marks'
import { store } from '../_store/store'
import uniqBy from 'lodash-es/uniqBy'
import isEqual from 'lodash-es/isEqual'
import { database } from '../_database/database'
import { concat } from '../_utils/arrays'
import { scheduleIdleTask } from '../_utils/scheduleIdleTask'
import { timelineItemToSummary } from '../_utils/timelineItemToSummary'

function getExistingItemIdsSet (instanceName, timelineName) {
  let timelineItemSummaries = store.getForTimeline(instanceName, timelineName, 'timelineItemSummaries') || []
  return new Set(timelineItemSummaries.map(_ => _.id))
}

function removeDuplicates (instanceName, timelineName, updates) {
  // remove duplicates, including duplicates due to reblogs
  let existingItemIds = getExistingItemIdsSet(instanceName, timelineName)
  return updates.filter(update => !existingItemIds.has(update.id))
}

async function insertUpdatesIntoTimeline (instanceName, timelineName, updates) {
  updates = removeDuplicates(instanceName, timelineName, updates)

  if (!updates.length) {
    return
  }

  await database.insertTimelineItems(instanceName, timelineName, updates)

  let itemSummariesToAdd = store.getForTimeline(instanceName, timelineName, 'timelineItemSummariesToAdd') || []
  console.log('itemSummariesToAdd', JSON.parse(JSON.stringify(itemSummariesToAdd)))
  console.log('updates.map(timelineItemToSummary)', JSON.parse(JSON.stringify(updates.map(timelineItemToSummary))))
  console.log('concat(itemSummariesToAdd, updates.map(timelineItemToSummary))',
    JSON.parse(JSON.stringify(concat(itemSummariesToAdd, updates.map(timelineItemToSummary)))))
  let newItemSummariesToAdd = uniqBy(
    concat(itemSummariesToAdd, updates.map(timelineItemToSummary)),
    _ => _.id
  )
  if (!isEqual(itemSummariesToAdd, newItemSummariesToAdd)) {
    console.log('adding ', (newItemSummariesToAdd.length - itemSummariesToAdd.length),
      'items to timelineItemSummariesToAdd for timeline', timelineName)
    store.setForTimeline(instanceName, timelineName, { timelineItemSummariesToAdd: newItemSummariesToAdd })
  }
}

function isValidStatusForThread (thread, timelineName, itemSummariesToAdd) {
  let itemSummariesToAddIdSet = new Set(itemSummariesToAdd.map(_ => _.id))
  let threadIdSet = new Set(thread.map(_ => _.id))
  let focusedStatusId = timelineName.split('/')[1] // e.g. "status/123456"
  let focusedStatusIdx = thread.findIndex(_ => _.id === focusedStatusId)
  return status => {
    let repliedToStatusIdx = thread.findIndex(_ => _.id === status.in_reply_to_id)
    return (
      // A reply to an ancestor status is not valid for this thread, but for the focused status
      // itself or any of its descendents, it is valid.
      repliedToStatusIdx >= focusedStatusIdx &&
      // Not a duplicate
      !threadIdSet.has(status.id) &&
      // Not already about to be added
      !itemSummariesToAddIdSet.has(status.id)
    )
  }
}

async function insertUpdatesIntoThreads (instanceName, updates) {
  if (!updates.length) {
    return
  }

  let threads = store.getThreads(instanceName)
  let timelineNames = Object.keys(threads)
  for (let timelineName of timelineNames) {
    let thread = threads[timelineName]

    let itemSummariesToAdd = store.getForTimeline(instanceName, timelineName, 'timelineItemSummariesToAdd') || []
    let validUpdates = updates.filter(isValidStatusForThread(thread, timelineName, itemSummariesToAdd))
    if (!validUpdates.length) {
      continue
    }
    let newItemSummariesToAdd = uniqBy(
      concat(itemSummariesToAdd, validUpdates.map(timelineItemToSummary)),
      _ => _.id
    )
    if (!isEqual(itemSummariesToAdd, newItemSummariesToAdd)) {
      console.log('adding ', (newItemSummariesToAdd.length - itemSummariesToAdd.length),
        'items to timelineItemSummariesToAdd for thread', timelineName)
      store.setForTimeline(instanceName, timelineName, { timelineItemSummariesToAdd: newItemSummariesToAdd })
    }
  }
}

async function processFreshUpdates (instanceName, timelineName) {
  mark('processFreshUpdates')
  let freshUpdates = store.getForTimeline(instanceName, timelineName, 'freshUpdates')
  if (freshUpdates && freshUpdates.length) {
    let updates = freshUpdates.slice()
    store.setForTimeline(instanceName, timelineName, { freshUpdates: [] })

    await Promise.all([
      insertUpdatesIntoTimeline(instanceName, timelineName, updates),
      insertUpdatesIntoThreads(instanceName, updates.filter(status => status.in_reply_to_id))
    ])
  }
  stop('processFreshUpdates')
}

function lazilyProcessFreshUpdates (instanceName, timelineName) {
  scheduleIdleTask(() => {
    /* no await */ processFreshUpdates(instanceName, timelineName)
  })
}

export function addStatusOrNotification (instanceName, timelineName, newStatusOrNotification) {
  addStatusesOrNotifications(instanceName, timelineName, [newStatusOrNotification])
}

export function addStatusesOrNotifications (instanceName, timelineName, newStatusesOrNotifications) {
  console.log('addStatusesOrNotifications', Date.now())
  let freshUpdates = store.getForTimeline(instanceName, timelineName, 'freshUpdates') || []
  freshUpdates = concat(freshUpdates, newStatusesOrNotifications)
  freshUpdates = uniqBy(freshUpdates, _ => _.id)
  store.setForTimeline(instanceName, timelineName, { freshUpdates: freshUpdates })
  lazilyProcessFreshUpdates(instanceName, timelineName)
}
