require('./hold')({
  title: 'vitest --watch',
  mb: 140,
  busy: 0.02,
  children: [
    { title: 'vitest worker 1', mb: 70, burst: [4500, 1500] },
    { title: 'vitest worker 2', mb: 64, burst: [4000, 2000] },
    { title: 'vitest worker 3', mb: 58, burst: [3000, 3000] },
  ],
})
