# Local Image Compress

Comprima arquivos PNG e JPEG diretamente no seu cofre do Obsidian no computador, sem serviços de nuvem nem APIs. Reduza em 30–70% o espaço usado pelas imagens sem sacrificar a qualidade.

Read in your language: [English](../README.md) • [العربية](README.ar.md) • [Deutsch](README.de.md) • [Español](README.es.md) • [فارسی](README.fa.md) • [Français](README.fr.md) • [Bahasa Indonesia](README.id.md) • [Italiano](README.it.md) • [Nederlands](README.nl.md) • [Polski](README.pl.md) • [Português](README.pt.md) • [Português (Brasil)](README.pt-br.md) • [Русский](README.ru.md) • [ไทย](README.th.md) • [Türkçe](README.tr.md) • [Українська](README.uk.md) • [Tiếng Việt](README.vi.md) • [日本語](README.ja.md) • [한국어](README.ko.md) • [中文简体](README.zh-cn.md) • [中文繁體](README.zh-tw.md)

![Local Image Compress features](Features.gif)

### Índice
- [Recursos](#recursos)
- [Formatos compatíveis](#formatos-compatíveis)
- [Configurações](#configurações)
- [Como funciona](#como-funciona)
- [Armazenamento de dados e backups](#armazenamento-de-dados-e-backups)
- [Automação](#automação)
- [Interação com o Paste Image Rename](#interação-com-o-paste-image-rename)
- [Privacidade e comportamento externo](#privacidade-e-comportamento-externo)
- [Dicas](#dicas)
- [Perguntas frequentes](#perguntas-frequentes)
- [Licença](#licença)

### Recursos
- **Compressão local**: imagens PNG e JPEG são comprimidas localmente.
- **Comandos**:
  - **Comprimir todas as imagens da nota**: processa as imagens referenciadas ou usadas na nota ativa.
  - **Comprimir todas as imagens da pasta**: permite escolher uma pasta e comprime todas as imagens compatíveis, exceto a pasta de saída.
  - **Comprimir todas as imagens do cofre**: verifica todo o cofre, exceto a pasta de saída.
  - **Mover arquivos comprimidos**: move os resultados para os locais dos arquivos originais. Antes, cria backups das versões original e comprimida.
- **Automação**:
  - Comprimir automaticamente novos arquivos quando são adicionados
  - Compressão em segundo plano após inatividade quando as imagens não comprimidas atingem o limite
- **Interface e conveniência**:
  - Menu de contexto para arquivos e pastas
  - Indicador de espaço economizado com dica detalhada
  - Indicador de progresso na barra de status
- **Segurança e confiabilidade**:
  - Cache dos arquivos processados com backups do cache
  - Backups antes de mover arquivos comprimidos, com exclusão automática

### Formatos compatíveis
- PNG (pipeline WASM `imagequant`)
- JPEG/JPG (pipeline WASM `mozjpeg`)

WebP, GIF, BMP, HEIC/HEIF e AVIF são ignorados intencionalmente nesta versão porque o plugin não inclui codificadores para esses formatos.

### Configurações

| Configuração | Descrição | Tipo/faixa | Padrão |
|---|---|---|---|
| Qualidade PNG (mín-máx) | Faixa de qualidade para quantização PNG com perdas | 1-100 (por ex. `65-80`) | `65-80` |
| Qualidade JPEG | Qualidade da compressão JPEG | 1-95 | `85` |
| Raízes permitidas | Caminhos relativos onde a compressão é permitida. Vazio = cofre inteiro | lista de strings | vazio |
| Pasta de saída | Pasta onde os arquivos comprimidos são salvos | string | `Compressed` |
| Comprimir novos arquivos automaticamente | Comprime novas imagens quando são adicionadas | booleano | `false` |
| Compressão em segundo plano | Comprime em segundo plano durante a inatividade | booleano | `true` |
| Limite de segundo plano | Número de imagens não comprimidas necessário para iniciar automaticamente | 10-1000 | `50` |
| Limite de inatividade | Minutos sem atividade antes do início da compressão | 1-60 minutos | `2` |
| Retenção automática de backups | Exclui automaticamente backups antigos anteriores à movimentação | booleano | `false` |
| Manter backups, dias | Exclui backups de movimentação com mais de N dias quando a retenção está ativa | 1-365 | `30` |
| Mover arquivos comprimidos automaticamente | Ao iniciar, move arquivos para os locais originais e substitui os originais | booleano | `false` |
| Limite de movimentação automática | Número de arquivos prontos que inicia a movimentação automática | 1-1000 | `50` |


### Como funciona
1. Os arquivos comprimidos são salvos em `Compressed`, mantendo a estrutura dos caminhos originais.
2. O cache registra os arquivos processados e seus tamanhos originais para evitar compressões repetidas e calcular corretamente a economia.
3. “Mover arquivos comprimidos” devolve os arquivos de `Compressed` aos locais originais se o original estiver em uma raiz permitida. Um backup é criado antes.

Arquivos muito pequenos geralmente são ignorados (`<5KB` para PNG e `<10KB` para JPEG).

Os limites internos de segurança são fixos: arquivos maiores que `100 MB` são ignorados antes da leitura, e imagens acima de `100 milhões` de pixels após a validação do cabeçalho.

### Armazenamento de dados e backups
- **Cache principal:** armazenado na pasta do plugin.
- **Backups do cache:** armazenados em `Vault/.local-image-compress/backups/cache/`; até 50 arquivos são mantidos.
- **Backups das imagens:** armazenados em `Vault/.local-image-compress/backups/originals/`; criados antes da substituição dos originais.

### Automação
- Ativar “Compressão em segundo plano” disponibiliza dois controles deslizantes:
  - Limite da compressão em segundo plano: 10–1000 imagens, padrão 50.
  - Limite de inatividade: 1–60 minutos, padrão 2.
- Ativar “Manter backups, dias” mostra o controle do período de retenção.
- Ativar “Mover arquivos comprimidos automaticamente” mostra o limite de arquivos. Ao iniciar, a movimentação começa quando os arquivos em `Compressed` atingem ou ultrapassam o limite.

### Interação com o Paste Image Rename

Este plugin desativa temporariamente `obsidian-paste-image-rename` durante a compressão ou movimentação. Essa proteção não pode ser desativada, pois associar o resultado comprimido ao original exige que outro plugin não renomeie os novos arquivos.

<details>
<summary>Por que essa proteção é necessária</summary>

Por que ela é necessária:

- O Paste Image Rename registra um manipulador `vault.on("create")` executado para cada imagem adicionada ao cofre cerca de um segundo após sua criação. Ele sempre atua em nomes iniciados por `Pasted image ` e em todas as outras imagens quando “Handle all attachments” está ativado.
- As cópias gravadas na pasta de saída ativam esse manipulador. Com uma visualização Markdown ativa, ele renomeia o resultado e quebra a associação necessária à movimentação, ou mostra uma caixa de diálogo para cada arquivo. Sem visualização ativa, mostra `Error: No active file found` para cada arquivo e enche a interface de erros durante o processamento em lote.
- O Obsidian não oferece uma API pública para um plugin pausar outro. Desativar temporariamente apenas esse plugin é a única solução confiável.

Tratamento seguro:

- Apenas o ID conhecido `obsidian-paste-image-rename` é afetado, somente durante a compressão ou movimentação.
- O plugin é restaurado depois, com novas tentativas se necessário, a menos que seu estado mude externamente. A proteção registra se foi ela que o desativou e não tenta restaurá-lo após essa mudança.
- A ativação e desativação usam a API interna `app.plugins` do Obsidian porque não há equivalente público. A disponibilidade dos recursos é verificada e os erros são tratados corretamente.

</details>

### Privacidade e comportamento externo

- **Rede**: não há solicitações de rede durante a execução. Os codecs PNG/JPEG estão em `main.js`; as imagens não são enviadas.
- **Telemetria e anúncios**: não há análise, telemetria, relatórios de falhas, rastreamento, anúncios dinâmicos nem atualização automática.
- **Contas e pagamentos**: não são necessários conta, assinatura, chave de licença ou pagamento. O plugin nunca acessa o link opcional de financiamento do manifesto.
- **Arquivos do cofre**: o plugin lê imagens escolhidas por comandos, automação ou raízes permitidas. Grava na pasta relativa configurada e só substitui originais pelo processo documentado de movimentação manual ou automática, após criar backups.
- **Estado local**: o cache fica na pasta do plugin. Os backups do cache e das movimentações ficam em `Vault/.local-image-compress/backups/`.
- **Arquivos externos**: os dados gerenciados permanecem no cofre atual. “Abrir pasta” apenas pede ao sistema operacional para mostrar as pastas documentadas e não transmite dados.
- **Outros plugins**: `obsidian-paste-image-rename` pode ser desativado temporariamente como descrito acima e depois restaurado com verificação de quem alterou o estado.

### Dicas
- Faixas de qualidade razoáveis: PNG `65-80`, JPEG `75-90`.
- Configure “Raízes permitidas” para comprimir apenas pastas como `files/` ou `images/`.
- Use a compressão em segundo plano quando o cofre tiver muitas imagens não comprimidas.

### Perguntas frequentes
**O plugin informa que os módulos WebAssembly não foram inicializados.**
Recarregue o plugin. Se o erro se repetir, inclua no relatório a versão do Obsidian, a plataforma e o erro do console.

**Onde os arquivos comprimidos são salvos?**
Em `Compressed` por padrão. Para substituir os originais, use “Mover arquivos comprimidos”.

**Como a economia é calculada?**
O cálculo é exato quando o cache contém os tamanhos original e final. Para PNG/JPEG não comprimidos, são usadas estimativas conservadoras com proporções limitadas; os tamanhos atuais são lidos do disco quando necessário.

### Licença
GPL-3.0-or-later. Licenças e avisos de terceiros: [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
