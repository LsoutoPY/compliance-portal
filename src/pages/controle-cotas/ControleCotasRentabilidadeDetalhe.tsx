import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { RentabilidadePage } from '@/components/rentabilidade/RentabilidadePage'

export default function ControleCotasRentabilidadeDetalhe() {
  const { cnpj } = useParams<{ cnpj: string }>()
  const navigate  = useNavigate()
  const [searchParams] = useSearchParams()
  const isin = searchParams.get("isin")

  if (!cnpj) {
    navigate('/rentabilidade')
    return null
  }

  return (
    <Layout>
      <button
        onClick={() => navigate('/rentabilidade')}
        className="flex items-center gap-1.5 text-sm text-muted-foreground
                   hover:text-foreground mb-4 transition-colors"
      >
        <ChevronLeft className="w-4 h-4" />
        Todos os fundos
      </button>

      <RentabilidadePage cnpj={cnpj} isin={isin} />
    </Layout>
  )
}
