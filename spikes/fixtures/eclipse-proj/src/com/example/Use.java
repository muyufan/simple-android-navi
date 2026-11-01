package com.example;
import com.lib.Greeter;
public class Use {
    public String run() {
        Greeter g = new Greeter();
        return g.greet("world");
    }
}
