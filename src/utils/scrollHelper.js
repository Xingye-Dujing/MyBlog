export async function eagerLoadImagesInRange(container, targetEl) {
  if (!container || !targetEl) return

  const messageEls = Array.from(container.querySelectorAll('.message-wrapper'))
  const targetIdx = messageEls.indexOf(targetEl)
  if (targetIdx === -1) return

  const scrollPos = container.scrollTop
  let startIdx = 0
  let cumulativeHeight = 0
  for (let i = 0; i < messageEls.length; i++) {
    cumulativeHeight += messageEls[i].offsetHeight
    if (cumulativeHeight > scrollPos) {
      startIdx = i
      break
    }
  }

  const minIdx = Math.min(startIdx, targetIdx)
  const maxIdx = Math.max(startIdx, targetIdx)

  const rangeImages = []
  for (let i = minIdx; i <= maxIdx; i++) {
    const imgs = messageEls[i]?.querySelectorAll('img[loading="lazy"]')
    if (imgs) rangeImages.push(...imgs)
  }

  if (rangeImages.length === 0) return

  const loadPromises = rangeImages.map((img) => {
    if (img.complete) return Promise.resolve()
    return new Promise((resolve) => {
      img.loading = 'eager'
      img.addEventListener('load', resolve, { once: true })
      img.addEventListener('error', resolve, { once: true })
    })
  })

  await Promise.race([Promise.all(loadPromises), new Promise((r) => setTimeout(r, 300))])
}
