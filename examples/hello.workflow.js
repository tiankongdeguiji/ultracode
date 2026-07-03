export const meta = {
  name: 'hello',
  description: 'Smallest possible workflow: one agent replies with a greeting',
  phases: [{ title: 'Greet' }],
}

phase('Greet')
const greeting = await agent('Reply with a single short greeting line and nothing else.', {
  label: 'greeter',
})
log('greeting received')
return { greeting }
