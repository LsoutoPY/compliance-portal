export type MaximumLimitStatus = 'ok' | 'alerta' | 'violacao';

export function statusLimiteMaximo(
  percentual: number,
  limiteMaximo: number,
  margemAlerta = 0.02,
): MaximumLimitStatus {
  if (percentual > limiteMaximo) return 'violacao';

  // Para limite zero não existe faixa de aproximação: exposição zero está
  // enquadrada, enquanto qualquer exposição positiva já é violação.
  if (
    limiteMaximo > 0 &&
    percentual > 0 &&
    percentual > Math.max(0, limiteMaximo - margemAlerta)
  ) {
    return 'alerta';
  }

  return 'ok';
}

export function statusLimiteMinimo(
  percentual: number,
  limiteMinimo: number,
  limiteAlerta?: number,
  dispensado = false,
): MaximumLimitStatus {
  if (dispensado) return 'ok';
  if (percentual < limiteMinimo) return 'violacao';
  if (limiteAlerta && percentual < limiteAlerta) return 'alerta';
  return 'ok';
}
