export function readGmailListing(expected){
      const url=new URL(location.href);
      if(url.origin!=='https://mail.google.com')return{accountVerified:false,listingVerified:false,rows:[]};
      const labels=[...document.querySelectorAll('a[aria-label],button[aria-label]')].slice(0,500).map(el=>el.getAttribute('aria-label')||'');
      const accountLabel=labels.find(label=>/Google (?:Account|account)|Google-Account/.test(label)&&(label.toLowerCase().match(/[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g)||[]).includes(expected))||'';
      const listingVerified=url.hash.startsWith('#search/')&&/is(?::|%3A)unread/i.test(decodeURIComponent(url.hash));
      const rows=[...document.querySelectorAll('tr.zA')].filter(el=>el.getClientRects().length&&el.classList.contains('zE')).slice(0,50).map(el=>({
        unread:el.classList.contains('zE'),sender:(el.querySelector('.yW')?.textContent||'').trim().slice(0,200),
        subject:(el.querySelector('.y6 .bog')?.textContent||el.querySelector('.bog')?.textContent||'').trim().slice(0,500),
        snippet:(el.querySelector('.y2')?.textContent||'').trim().slice(0,800),date:(el.querySelector('.xW [title]')?.getAttribute('title')||el.querySelector('.xW')?.textContent||'').trim().slice(0,150),
        listingText:el.innerText.slice(0,1600)
      }));
      const emptyVerified=!!document.querySelector('[role="main"]')&&/No conversations found|No messages matched|No results found/i.test(document.querySelector('[role="main"]')?.innerText||'');
      return{accountVerified:!!accountLabel,listingVerified:listingVerified&&(rows.length>0||emptyVerified),account:expected,rows,emptyVerified,coverage:'First visible unread search page, at most 50 listing rows; full bodies were not opened.',url:url.origin+url.pathname+url.hash};
}
