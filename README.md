# 🎬 CineRank — Filmes em Cartaz

**Acesse o projeto ao vivo:** [https://alexsami-lopes.github.io/tmdb-scraper/](https://alexsami-lopes.github.io/tmdb-scraper/)

CineRank é um painel (dashboard) interativo e responsivo focado em ranquear e monitorar a evolução de filmes atualmente em cartaz nos cinemas. O projeto exibe tendências, pontuações, histórico de notas e um acompanhamento visual detalhado do sobe-e-desce dos filmes no "Top 20" ao longo dos dias.

---

## 🏗️ Arquitetura e Stack Tecnológico

O projeto foi construído com uma arquitetura *Serverless* leve e acessível, utilizando o ecossistema do Google como backend.

* **Frontend:** HTML5, CSS3 puro (com variáveis e design responsivo) e Vanilla JavaScript. Nenhuma biblioteca de UI pesada foi utilizada, garantindo alta performance.
* **Visualização de Dados:** Chart.js (com plugins customizados desenhando diretamente no Canvas).
* **Backend / API:** Google Apps Script (`Code.gs`). O script atua como uma API REST que o frontend consome e o scraper alimenta.
* **Banco de Dados:** Google Sheets. A planilha serve como o repositório central onde os dados históricos, elenco e logs de execução são armazenados estruturalmente.

---

## ⚙️ Coleta de Dados e Integração (TMDB Scraping)

Os dados não são inseridos manualmente. Um scraper automatizado varre a API do TMDB (The Movie Database), focando na categoria de lançamentos (*Now Playing*). 

Esses dados são enviados via requisição `POST` para o nosso backend (Google Apps Script), que armazena as seguintes informações essenciais: ID, Título, Pôster, Nota, Gêneros e Elenco. O armazenamento diário cria um retrato cronológico da bilheteria.

---

## 💻 Backend: Como funciona o `Code.gs`

O arquivo `Code.gs` é o coração do projeto. Ele roda no Google Apps Script acoplado a uma planilha e intercepta requisições HTTP (`doGet` e `doPost`).

* **POST:** Recebe a carga de dados do scraper. Ele valida a segurança através de um `SECRET`, cria as planilhas (`filmes`, `elenco`, `runs`) caso não existam, deduplica entradas para não haver filmes repetidos no mesmo dia, salva os dados e limpa o cache.
* **GET:** Fornece os dados mastigados para o frontend. Possui rotas de busca (`?action=search`), histórico (`?action=history`), ranking, e tendências. Utiliza o `CacheService` do Google (5 minutos de TTL) para garantir que a dashboard carregue rapidamente sem sobrecarregar a planilha.

### 🛠️ Como rodar o Backend no seu Google Drive

Se você quiser clonar e rodar a sua própria versão da API, siga os passos abaixo:

1. **Crie a Planilha:** Crie uma nova planilha em branco no [Google Sheets](https://sheets.google.com).
2. **Abra o Script:** No menu superior, vá em `Extensões` > `Apps Script`.
3. **Cole o Código:** Apague o código padrão (`function myFunction() {}`) e cole todo o conteúdo do arquivo `Code.gs`.
4. **Configure a Variável de Ambiente (SECRET):**
   * No menu lateral esquerdo do Apps Script, clique no ícone de engrenagem (Configurações do Projeto).
   * Desça até a seção **Propriedades do script** e clique em **Adicionar propriedade do script**.
   * Em *Propriedade*, digite exatamente `SECRET`.
   * Em *Valor*, digite uma senha segura da sua escolha (ex: `minha_senha_super_secreta_123`).
   * Salve as propriedades do script. *(Nota: O scraper que você for utilizar para enviar os dados via POST precisará enviar esse mesmo secret no corpo da requisição).*
5. **Implante a API (Deploy):**
   * Clique no botão azul **Implantar** (Deploy) no canto superior direito > **Nova implantação**.
   * Selecione o tipo **App da Web** (Web app).
   * Em *Executar como*, selecione `Eu`.
   * Em *Quem tem acesso*, selecione `Qualquer pessoa` (necessário para o frontend público ler os dados).
   * Clique em **Implantar**. Autorize as permissões na sua conta Google quando solicitado.
   * Copie a **URL do App da Web**. É essa URL que você deve colar na constante `API` dentro do `index.html` do seu frontend.

---

## 🖥️ Interface e Funcionalidades (UI/UX)

A interface foi desenhada com um aspecto *premium* (fundo escuro, fontes em serif e detalhes em dourado) e possui as seguintes seções:

* **Header e Seletor de Data:** Permite ao usuário navegar no tempo, escolhendo datas passadas para ver como estava o ranking. Inclui cache local via `sessionStorage`.
* **Hero Section:** Destaque rotativo automático dos filmes mais bem avaliados do dia, exibindo pôster em tela cheia.
* **Top 10 Melhores Avaliados & Top 20 Em Cartaz:** Listas visuais ranqueadas, barras de progresso e grid dinâmico de cards.
* **Histórico de um Filme & Tendências:** Barra de busca que retorna a linha do tempo do filme e um mini-gráfico de evolução, além da persistência dos filmes em cartaz.
* **Evolução (Gráfico Principal):** Gráfico de linhas com Chart.js mostrando a evolução do Top 20.
    * *Inovações UX/UI:* Pôsteres desenhados redondos diretamente no canvas; responsividade fluida via recálculo matemático da altura da linha (`rowHeight`); eventos nativos de clique acoplados a hitboxes invisíveis.
* **Modal de Detalhes:** Exibição de detalhes ricos ao clicar em qualquer filme, puxando inclusive as fotos de perfil do elenco.