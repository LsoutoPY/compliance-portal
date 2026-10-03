/** Mensagem legível a partir de erros PostgREST / Supabase */
export function formatSupabaseError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const e = error as { message?: string; details?: string; hint?: string; code?: string }
    const parts = [e.message, e.details, e.hint].filter(Boolean)
    if (parts.length > 0) return parts.join(' — ')
    if (e.code) return `Erro ${e.code}`
  }
  return 'Erro desconhecido ao buscar dados.'
}

export function isMissingColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { message?: string; code?: string }
  const msg = (e.message ?? '').toLowerCase()
  return (
    e.code === '42703' ||
    msg.includes('does not exist') ||
    msg.includes('column') && msg.includes('not exist')
  )
}

export function isMissingRelationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { message?: string; code?: string }
  const msg = (e.message ?? '').toLowerCase()
  return e.code === '42P01' || msg.includes('relation') && msg.includes('does not exist')
}
