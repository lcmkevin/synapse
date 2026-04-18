" Save as ~/.vim/autoload/synapse.vim or ~/.config/nvim/autoload/synapse.vim

function! synapse#connect()
  if has('nvim')
    lua << EOF
      local ok, websocket = pcall(require, 'websocket')
      if not ok then
        print('Synapse: Requires a websocket Lua module')
        return
      end
      local ws = websocket.connect('ws://localhost:3457?ide=vim&workspace=' .. vim.fn.getcwd())
      ws.on('open', function() print('Synapse: Connected') end)
      ws.on('message', function(data)
        local resp = vim.fn.json_decode(data)
        if resp.type == 'sync_complete' then print('Synapse: Sync done!') end
      end)
      _G.synapse_ws = ws
EOF
  else
    echo "Synapse: Requires Neovim with websocket support"
  endif
endfunction

function! synapse#sync(target)
  call synapse#send({'type': 'sync', 'target': a:target, 'requestId': localtime()})
endfunction

function! synapse#send(msg)
  if exists('g:synapse_ws')
    let l:json = json_encode(a:msg)
    lua _G.synapse_ws:send(vim.fn.eval('l:json'))
  else
    echo "Run :SynapseConnect first"
  endif
endfunction

command! SynapseConnect call synapse#connect()
command! SynapseSync call synapse#sync('all')

