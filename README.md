## cables mcp server

cables mcp server as an operator. this enables communication of an llm/ai with cables code editor directly. 
USE WITH CAUTION

#### how to install op

- check out this repository
- start cables standalone
- add folder of this repository as an op dir
- you should be able to use McpServer op now
- open op code editor by pressing [e] and then you should be able to chat about this code
#### add mcp server to terminal claude code

```
claude mcp add --transport http my-server http://localhost:3000/mcp
```

