# Local Image Compress

Comprima ficheiros PNG e JPEG diretamente no seu cofre Obsidian no computador, sem serviços na nuvem nem API. Reduza em 30–70% o espaço ocupado pelas imagens sem sacrificar a qualidade.

Read in your language: [English](../README.md) • [العربية](README.ar.md) • [Deutsch](README.de.md) • [Español](README.es.md) • [فارسی](README.fa.md) • [Français](README.fr.md) • [Bahasa Indonesia](README.id.md) • [Italiano](README.it.md) • [Nederlands](README.nl.md) • [Polski](README.pl.md) • [Português](README.pt.md) • [Português (Brasil)](README.pt-br.md) • [Русский](README.ru.md) • [ไทย](README.th.md) • [Türkçe](README.tr.md) • [Українська](README.uk.md) • [Tiếng Việt](README.vi.md) • [日本語](README.ja.md) • [한국어](README.ko.md) • [中文简体](README.zh-cn.md) • [中文繁體](README.zh-tw.md)

![Local Image Compress features](Features.gif)

### Índice
- [Funcionalidades](#funcionalidades)
- [Formatos suportados](#formatos-suportados)
- [Definições](#definições)
- [Como funciona](#como-funciona)
- [Armazenamento de dados e cópias de segurança](#armazenamento-de-dados-e-cópias-de-segurança)
- [Automatização](#automatização)
- [Interação com o Paste Image Rename](#interação-com-o-paste-image-rename)
- [Privacidade e comportamento externo](#privacidade-e-comportamento-externo)
- [Sugestões](#sugestões)
- [Perguntas frequentes](#perguntas-frequentes)
- [Licença](#licença)

### Funcionalidades
- **Compressão local**: as imagens PNG e JPEG são comprimidas localmente.
- **Comandos**:
  - **Comprimir todas as imagens da nota**: processa as imagens referenciadas ou utilizadas na nota ativa.
  - **Comprimir todas as imagens da pasta**: permite escolher uma pasta e comprime todas as imagens suportadas, exceto a pasta de saída.
  - **Comprimir todas as imagens do cofre**: analisa o cofre inteiro, exceto a pasta de saída.
  - **Mover ficheiros comprimidos**: move os resultados para as localizações dos originais. Antes, cria cópias das versões original e comprimida.
- **Automatização**:
  - Comprimir automaticamente novos ficheiros quando são adicionados
  - Compressão em segundo plano após inatividade quando as imagens não comprimidas atingem o limite
- **Interface e conveniência**:
  - Menu de contexto para ficheiros e pastas
  - Indicador de espaço poupado com descrição detalhada
  - Indicador de progresso na barra de estado
- **Segurança e fiabilidade**:
  - Cache de ficheiros processados com cópias da cache
  - Cópias de segurança antes de mover ficheiros comprimidos, com eliminação automática

### Formatos suportados
- PNG (pipeline WASM `imagequant`)
- JPEG/JPG (pipeline WASM `mozjpeg`)

WebP, GIF, BMP, HEIC/HEIF e AVIF são intencionalmente ignorados nesta versão porque o plugin não inclui codificadores para esses formatos.

### Definições

| Definição | Descrição | Tipo/intervalo | Predefinição |
|---|---|---|---|
| Qualidade PNG (mín-máx) | Intervalo de qualidade da quantização PNG com perdas | 1-100 (por ex. `65-80`) | `65-80` |
| Qualidade JPEG | Qualidade da compressão JPEG | 1-95 | `85` |
| Raízes permitidas | Caminhos relativos onde a compressão é permitida. Vazio = cofre inteiro | lista de cadeias | vazio |
| Pasta de saída | Pasta onde os ficheiros comprimidos são guardados | cadeia | `Compressed` |
| Comprimir novos ficheiros automaticamente | Comprime novas imagens quando são adicionadas | booleano | `false` |
| Compressão em segundo plano | Comprime em segundo plano durante a inatividade | booleano | `true` |
| Limite de segundo plano | Número de imagens não comprimidas necessário para iniciar automaticamente | 10-1000 | `50` |
| Limite de inatividade | Minutos sem atividade antes de iniciar a compressão | 1-60 minutos | `2` |
| Retenção automática de cópias | Elimina automaticamente cópias antigas anteriores à movimentação | booleano | `false` |
| Manter cópias, dias | Elimina cópias de movimentação com mais de N dias quando a retenção está ativa | 1-365 | `30` |
| Mover ficheiros comprimidos automaticamente | Repõe ao iniciar os ficheiros nas localizações originais, substituindo-os | booleano | `false` |
| Limite de movimentação automática | Número de ficheiros prontos que inicia a movimentação automática | 1-1000 | `50` |


### Como funciona
1. Os ficheiros comprimidos são guardados em `Compressed`, mantendo a estrutura dos caminhos originais.
2. A cache regista os ficheiros processados e tamanhos originais para evitar compressões repetidas e calcular corretamente a poupança.
3. «Mover ficheiros comprimidos» repõe os ficheiros de `Compressed` nas localizações originais se o original estiver numa raiz permitida. É criada uma cópia antes da movimentação.

Ficheiros muito pequenos são normalmente ignorados (`<5KB` para PNG e `<10KB` para JPEG).

Os limites internos de segurança são fixos: ficheiros maiores que `100 MB` são ignorados antes da leitura e imagens acima de `100 milhões` de píxeis após a validação do cabeçalho.

### Armazenamento de dados e cópias de segurança
- **Cache principal:** guardada na pasta do plugin.
- **Cópias da cache:** em `Vault/.local-image-compress/backups/cache/`; são mantidos até 50 ficheiros.
- **Cópias das imagens:** em `Vault/.local-image-compress/backups/originals/`; criadas antes de substituir os originais.

### Automatização
- Ativar «Compressão em segundo plano» disponibiliza dois controlos deslizantes:
  - Limite de compressão: 10–1000 imagens, predefinição 50.
  - Limite de inatividade: 1–60 minutos, predefinição 2.
- Ativar «Manter cópias, dias» mostra o controlo do período de retenção.
- Ativar «Mover ficheiros comprimidos automaticamente» mostra o limite de ficheiros. Ao iniciar, a movimentação começa quando os ficheiros em `Compressed` atingem ou ultrapassam o limite.

### Interação com o Paste Image Rename

Este plugin desativa temporariamente `obsidian-paste-image-rename` durante a compressão ou movimentação. Esta proteção não pode ser desativada, pois associar o resultado comprimido ao original exige que outro plugin não mude o nome dos novos ficheiros.

<details>
<summary>Porque esta proteção é necessária</summary>

Por que é necessária:

- O Paste Image Rename regista um processador `vault.on("create")` executado para cada imagem adicionada ao cofre cerca de um segundo após a criação. Atua sempre em nomes iniciados por `Pasted image ` e em todas as outras imagens se «Handle all attachments» estiver ativo.
- As cópias escritas na pasta de saída ativam esse processador. Com uma vista Markdown ativa, muda o nome do resultado e quebra a associação necessária à movimentação, ou mostra um diálogo por ficheiro. Sem vista ativa, mostra `Error: No active file found` para cada ficheiro e enche a interface de erros durante o processamento em lote.
- O Obsidian não tem uma API pública que permita a um plugin pausar outro. Desativar temporariamente apenas este plugin é a única solução fiável.

Tratamento seguro:

- Apenas o ID conhecido `obsidian-paste-image-rename` é afetado, apenas durante compressão ou movimentação.
- O plugin é restaurado depois, com novas tentativas se necessário, salvo se o estado mudar externamente. A proteção regista se foi ela que o desativou e não tenta restaurá-lo após essa mudança.
- A ativação e desativação usam a API interna `app.plugins` do Obsidian, pois não há equivalente público. A disponibilidade das funções é verificada e os erros são tratados corretamente.

</details>

### Privacidade e comportamento externo

- **Rede**: não há pedidos de rede em execução. Os codecs PNG/JPEG estão incluídos em `main.js`; as imagens não são carregadas.
- **Telemetria e publicidade**: não há análise, telemetria, relatórios de falhas, rastreio, anúncios dinâmicos nem atualização automática.
- **Contas e pagamentos**: não são necessários conta, subscrição, chave de licença ou pagamento. O plugin nunca acede à ligação opcional de financiamento do manifesto.
- **Ficheiros do cofre**: o plugin lê imagens escolhidas por comandos, automatização ou raízes permitidas. Escreve na pasta relativa configurada e só substitui originais pelo processo documentado de movimentação manual ou automática, após criar cópias.
- **Estado local**: a cache fica na pasta do plugin. As cópias da cache e das movimentações ficam em `Vault/.local-image-compress/backups/`.
- **Ficheiros externos**: os dados geridos permanecem no cofre atual. «Abrir pasta» apenas pede ao sistema operativo que mostre as pastas documentadas e não transmite dados.
- **Outros plugins**: `obsidian-paste-image-rename` pode ser temporariamente desativado como descrito acima e depois restaurado com verificação de quem alterou o estado.

### Sugestões
- Intervalos de qualidade razoáveis: PNG `65-80`, JPEG `75-90`.
- Configure «Raízes permitidas» para comprimir apenas pastas como `files/` ou `images/`.
- Use a compressão em segundo plano quando o cofre tiver muitas imagens não comprimidas.

### Perguntas frequentes
**O plugin indica que os módulos WebAssembly não foram inicializados.**
Recarregue o plugin. Se o erro se repetir, inclua no relatório a versão do Obsidian, plataforma e erro da consola.

**Onde são guardados os ficheiros comprimidos?**
Em `Compressed` por predefinição. Para substituir os originais, use «Mover ficheiros comprimidos».

**Como é calculada a poupança?**
O cálculo é exato quando a cache contém os tamanhos original e final. Para PNG/JPEG não comprimidos usam-se estimativas conservadoras com rácios limitados; os tamanhos atuais são lidos do disco quando necessário.

### Licença
GPL-3.0-or-later. Licenças e avisos de terceiros: [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
