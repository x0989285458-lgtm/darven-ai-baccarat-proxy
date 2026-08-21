const delayMs = 150
setTimeout(() => process.send?.({ type: 'ready' }), delayMs)
process.on('message', (message) => {
  if (message?.type === 'stop') process.exit(0)
})
process.on('disconnect', () => process.exit(0))
