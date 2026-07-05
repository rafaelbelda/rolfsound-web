/* ============================================================
   ROLFSOUND V2 — Camada de dados (fonte única da UI)
   render.js constrói o Acervo e a fila a partir deste objeto,
   e os demais módulos (acervo.js, busca, playlists, remixer)
   leem tudo do DOM renderizado. Para integrar com o backend,
   preencha window.RolfsoundData ANTES de render.js rodar
   (ex.: um script entre data.js e render.js, ou gerar este
   arquivo no servidor).

   Formato de faixa:
   {
     id:     'a1b2c3',             // id único (ex.: id do banco)
     title:  'Coordinate Drift',
     artist: 'Rolf',
     album:  'Lattice',            // título do álbum ('Single' p/ avulsas) — herdado
     album_id: 'al_ab12cd',        // álbum dono da faixa (agrupa "Ver álbum")
     album_total: 12,              // "número de músicas" do álbum (0 = derivar)
     album_kind: 'album',          // 'album' | 'single'
     year:   '2023',               // do álbum (herdado)
     genre:  'ambient',            // do álbum (herdado)
     track_no: 3,                  // nº da faixa dentro do álbum (0 = sem número)
     added:  1750593600000,        // epoch ms
     bpm:    118,
     key:    'A min',
     fmt:    'vinil',              // 'vinil' | 'cd' | 'digital'
     state:  'master',             // 'master' | 'edit' | 'rip'
     fav:    false,
     tags:   ['ambient'],
     dur:    228,                  // segundos
     cover:  'linear-gradient(150deg,#c8693c,#5a2f1a 56%,#141416)', // background CSS
     group:  '',                   // id do grupo de versões ('' = solta)
     vlabel: '',                   // rótulo da versão ('Instrumental', …)
     primary: false               // é a versão que representa a "pasta" no Acervo
   }

   Formato de álbum (window.RolfsoundData.albums, chaveado por album_id):
   {
     id: 'al_ab12cd', title: 'Lattice', artist: 'Rolf',
     year: '2023', genre: 'ambient',
     total: 12,          // "número de músicas" declarado (0 = derivar da contagem)
     count: 9,           // faixas de fato no acervo
     kind: 'album',      // 'album' | 'single'
     cover: "url('…') …" // background CSS (capa do álbum ou derivada das faixas)
   }
   ============================================================ */
window.RolfsoundData = {
  tracks: [],     // faixas do cofre
  albums: {},     // { 'al_xxx': { …campos do álbum… } } — fonte da herança
  queue: [],      // ids das faixas na fila "A seguir", em ordem
  playlists: [],  // { id: 'p1', name: 'Nome', tracks: ['id-da-faixa', …] }
  // Grupos de versões: { 'vg_xxx': { primary: 'id', members: ['id', …] } }
  groups: {},
  // Conta: admin habilita a aba Discovery (YouTube via yt-dlp).
  // A UI só ESCONDE o recurso — o bloqueio real é 403 no servidor.
  account: { admin: false },
};
