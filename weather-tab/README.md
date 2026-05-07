# Weather Tracker

Dashboard estática de clima para a operação NABev na América Latina (Brasil, Argentina, Colômbia, Honduras, El Salvador). Compara temperatura e precipitação do período atual com o ano anterior (LY) e com uma climatologia interna de 5 anos, usando a API pública [Open-Meteo](https://open-meteo.com/).

## Estrutura do repositório

| Pasta | Conteúdo |
|-------|----------|
| [`dashboard/`](dashboard/) | Produto final: HTML + CSS + JS auto-contidos. Abrir `index.html` no navegador. |
| [`docs/`](docs/) | Documentação, scripts Node/Python, relatórios gerados e `package.json` das ferramentas. |
| [`docs/governance/`](docs/governance/) | Pacote de contexto para humanos e IA (INDEX, CONTEXT, DIAGRAMS, HANDOFF). |
| [`docs/reports/`](docs/reports/) | Relatórios gerados: auditoria de dados (DOCX) e justificativa de cidades (PDF). |

## Uso rápido

### Como utilizador final

1. Abrir [`dashboard/index.html`](dashboard/index.html) num navegador moderno (Chrome, Edge, Firefox) com acesso à internet.
2. Escolher país, região e estados nos filtros.
3. Ver snapshot, period scorecards, gráficos e, se desejado, exportar CSV.

Para distribuir a terceiros, comprimir a pasta `dashboard/` em ZIP e enviar — basta abrir `index.html` no destino (com internet).

### Como desenvolvedor

**Requisitos**: Node.js 18+, Python 3.10+ (apenas para os geradores de PDF), acesso à internet.

```powershell
# Instalar dependências Node (geradores de relatório, verificações)
cd docs
npm install

# Regenerar a base histórica (LY + climatologia) para todos os países
cd ..
.\dashboard\update-historical.bat

# Ou, apenas um país, forçando refresh:
.\dashboard\update-historical.bat --countries=br --force
```

Scripts disponíveis a partir de `docs/`:

| Script | Descrição |
|--------|-----------|
| `npm run verify:ranges` | Regression check da lógica de períodos e ranges. |
| `npm run audit:docx` | (Re)gera o relatório Word de auditoria em `docs/reports/`. |
| `node scripts/generate-historical.mjs [--countries=br --force]` | Equivalente direto ao `.bat`. |
| `python scripts/generate-city-report.py` | Gera o PDF de justificativa de cidades (PT, todos os países). |
| `python scripts/generate-city-report-en-hn-sv.py` | Gera o PDF de justificativa de cidades (EN, HN + SV). |

Para adicionar um novo país, ver [`docs/adding-countries.md`](docs/adding-countries.md).

## Parâmetros canónicos

| Parâmetro | Valor | Definido em |
|-----------|-------|-------------|
| Janela de climatologia | 5 anos completos | `dashboard/js/app.js` (`CLIM_FULL_YEARS`) |
| Horizonte máximo de forecast | 16 dias | `dashboard/js/app.js` (`MAX_FORECAST_DAYS`) |
| Limiar de dia de chuva | ≥ 1.0 mm/dia | `dashboard/js/app.js` (`RAIN_MM`) |
| Temperatura média | (Tmax + Tmin) / 2 | lógica de `app.js` |

> Nota: os mesmos valores existem em `docs/scripts/lib/dashboard-ranges.mjs` (fonte de verdade para os geradores Node). **Alterar sempre nos dois sítios.**

## Governança

A pasta [`docs/governance/`](docs/governance/) contém o pacote mínimo de contexto para humanos e agentes de IA retomarem o trabalho sem perder contexto:

- [`INDEX.md`](docs/governance/INDEX.md) — índice e como usar
- [`CONTEXT.md`](docs/governance/CONTEXT.md) — o que é o projeto, entregáveis, pastas e convenções
- [`DIAGRAMS.md`](docs/governance/DIAGRAMS.md) — diagramas Mermaid (fluxo + sequência)
- [`HANDOFF.md`](docs/governance/HANDOFF.md) — estado atual, decisões e próximos passos

Visão geral do produto, partilha e parâmetros estão neste **README na raiz**.

## Limitações conhecidas

- Temperatura é derivada de modelo (ECMWF / ERA5), não de estações físicas.
- Cada estado é representado por um único ponto (primeira cidade listada em `dashboard/data/locations-data.js`).
- Climatologia é de 5 anos internos, não o padrão WMO de 30 anos.
- MTD fixa o seu fim no dia 15 após essa data, por design.

## Créditos

Dados meteorológicos por [Open-Meteo](https://open-meteo.com/). Gráficos por [Chart.js](https://www.chartjs.org/).
